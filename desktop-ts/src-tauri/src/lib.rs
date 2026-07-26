//! INVESTigator desktop shell.
//!
//! The whole engine lives in TypeScript and runs in the WebView; Rust's jobs are to
//! (1) register the plugins the engine's platform adapter talks to, (2) provide the
//! two things a WebView can't do itself — send SMTP email and register Windows
//! scheduled tasks, and (3) run a scheduled digest HEADLESSLY: a task fires
//! `investigator.exe run-schedule <id>`, which launches a HIDDEN window; the
//! frontend runs that digest, delivers it, and exits. Everything else — ingestion,
//! scoring, look-through, narrative — is the same TypeScript the harnesses verify.

use serde::Deserialize;
use tauri::Manager;

#[derive(Deserialize)]
struct SmtpConfig {
    host: String,
    port: Option<u16>,
    user: Option<String>,
    password: Option<String>,
    from: Option<String>,
    to: Option<String>,
}

/// Send one email over SMTP+STARTTLS. Mirrors deliver/email.py: sender defaults to
/// the login user, recipient to the sender, and app-password spaces are stripped.
/// The blocking transport runs off the async runtime so it never stalls the UI.
#[tauri::command]
async fn send_email(cfg: SmtpConfig, subject: String, body: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || send_email_blocking(cfg, subject, body))
        .await
        .map_err(|e| e.to_string())?
}

fn send_email_blocking(cfg: SmtpConfig, subject: String, body: String) -> Result<(), String> {
    use lettre::transport::smtp::authentication::Credentials;
    use lettre::{Message, SmtpTransport, Transport};

    let sender = cfg
        .from
        .clone()
        .filter(|s| !s.is_empty())
        .or_else(|| cfg.user.clone())
        .ok_or("Email not configured — missing your email address")?;
    let recipient = cfg
        .to
        .clone()
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| sender.clone());

    let mut builder = Message::builder()
        .from(sender.parse().map_err(|e| format!("bad sender: {e}"))?)
        .subject(subject);
    for addr in recipient.split(',') {
        builder = builder.to(addr.trim().parse().map_err(|e| format!("bad recipient: {e}"))?);
    }
    let email = builder.body(body).map_err(|e| e.to_string())?;

    let mut transport = SmtpTransport::starttls_relay(&cfg.host)
        .map_err(|e| e.to_string())?
        .port(cfg.port.unwrap_or(587));
    if let Some(user) = cfg.user.filter(|u| !u.is_empty()) {
        let password = cfg.password.unwrap_or_default().replace(' ', "");
        transport = transport.credentials(Credentials::new(user, password));
    }
    transport.build().send(&email).map_err(|e| e.to_string())?;
    Ok(())
}

/// The schedule id this process was launched to run (from `run-schedule <id>`), or
/// None for a normal launch. The frontend polls this to decide headless vs. UI.
struct LaunchTask(Option<String>);

#[tauri::command]
fn pending_scheduled_run(state: tauri::State<LaunchTask>) -> Option<String> {
    state.0.clone()
}

#[tauri::command]
fn exit_app(app: tauri::AppHandle) {
    app.exit(0);
}

/// Register each enabled schedule as a Windows scheduled task (Windows only).
#[tauri::command]
fn sync_schedules() -> serde_json::Value {
    #[cfg(windows)]
    {
        windows_sched::sync()
    }
    #[cfg(not(windows))]
    {
        serde_json::json!({ "ok": true, "results": [] })
    }
}

// ---------------------------------------------------------------------------------
// Windows Task Scheduler integration — a Rust port of scheduler.py. Each enabled
// schedule becomes a task that runs `investigator.exe run-schedule <id>`. Tasks are
// created from XML so they carry StartWhenAvailable (run a missed run on next
// power-on). schtasks is invoked with CREATE_NO_WINDOW so no console ever flashes.
#[cfg(windows)]
mod windows_sched {
    use std::collections::HashSet;
    use std::os::windows::process::CommandExt;
    use std::path::Path;
    use std::process::Command;

    const NO_WINDOW: u32 = 0x0800_0000; // CREATE_NO_WINDOW
    const PREFIX: &str = "INVESTigator"; // distinct from the Python app's "Investraton"

    #[derive(serde::Deserialize, Default)]
    struct Sched {
        #[serde(default)]
        id: String,
        #[serde(default)]
        name: String,
        #[serde(default = "weekly")]
        frequency: String,
        #[serde(default = "at8")]
        time: String,
        #[serde(default = "yes")]
        enabled: bool,
    }
    fn weekly() -> String {
        "weekly".into()
    }
    fn at8() -> String {
        "08:00".into()
    }
    fn yes() -> bool {
        true
    }

    pub fn sync() -> serde_json::Value {
        let path = match std::env::var("APPDATA") {
            Ok(a) => Path::new(&a).join("Investraton").join("config").join("schedules.json"),
            Err(_) => return serde_json::json!({ "ok": false, "error": "APPDATA not set", "results": [] }),
        };
        let scheds: Vec<Sched> = std::fs::read_to_string(&path)
            .ok()
            .and_then(|t| serde_json::from_str(&t).ok())
            .unwrap_or_default();
        let exe = std::env::current_exe()
            .map(|p| p.to_string_lossy().into_owned())
            .unwrap_or_default();

        let mut results = Vec::new();
        let mut wanted: HashSet<String> = HashSet::new();
        for s in &scheds {
            if !s.enabled || s.id.is_empty() {
                continue;
            }
            let task = format!("{PREFIX}\\{}", s.id);
            wanted.insert(task.clone());
            let ok = create_task(&task, &task_xml(s, &exe));
            results.push(serde_json::json!({ "name": s.name, "id": s.id, "ok": ok }));
        }
        // Remove tasks we own but no longer want (deleted / disabled).
        for name in list_tasks() {
            if name.starts_with(&format!("{PREFIX}\\")) && !wanted.contains(&name) {
                let _ = Command::new("schtasks")
                    .args(["/Delete", "/F", "/TN", &name])
                    .creation_flags(NO_WINDOW)
                    .output();
            }
        }
        let all_ok = results.iter().all(|r| r["ok"].as_bool().unwrap_or(false));
        serde_json::json!({ "ok": all_ok, "results": results })
    }

    fn create_task(task: &str, xml: &str) -> bool {
        let tmp = std::env::temp_dir().join(format!("investigator_{}.xml", task.replace('\\', "_")));
        if write_utf16(&tmp, xml).is_err() {
            return false;
        }
        let out = Command::new("schtasks")
            .args(["/Create", "/TN", task, "/XML", &tmp.to_string_lossy(), "/F"])
            .creation_flags(NO_WINDOW)
            .output();
        let _ = std::fs::remove_file(&tmp);
        matches!(out, Ok(o) if o.status.success())
    }

    fn list_tasks() -> Vec<String> {
        let mut names = Vec::new();
        if let Ok(o) = Command::new("schtasks")
            .args(["/Query", "/FO", "LIST"])
            .creation_flags(NO_WINDOW)
            .output()
        {
            for line in String::from_utf8_lossy(&o.stdout).lines() {
                if let Some(rest) = line.strip_prefix("TaskName:") {
                    names.push(rest.trim().trim_start_matches('\\').to_string());
                }
            }
        }
        names
    }

    /// Task Scheduler XML must be UTF-16. Write UTF-16LE with a BOM.
    fn write_utf16(path: &Path, s: &str) -> std::io::Result<()> {
        let mut bytes = vec![0xFF, 0xFE];
        for u in s.encode_utf16() {
            bytes.extend_from_slice(&u.to_le_bytes());
        }
        std::fs::write(path, bytes)
    }

    fn xml_escape(s: &str) -> String {
        s.replace('&', "&amp;")
            .replace('<', "&lt;")
            .replace('>', "&gt;")
            .replace('"', "&quot;")
            .replace('\'', "&apos;")
    }

    fn trigger_xml(freq: &str, time: &str) -> String {
        let start = format!("{}T{}:00", chrono::Local::now().format("%Y-%m-%d"), time);
        let sb = match freq {
            "daily" => "<ScheduleByDay><DaysInterval>1</DaysInterval></ScheduleByDay>".to_string(),
            "every_3_days" => "<ScheduleByDay><DaysInterval>3</DaysInterval></ScheduleByDay>".to_string(),
            "monthly" => {
                let months: String = [
                    "January", "February", "March", "April", "May", "June", "July", "August",
                    "September", "October", "November", "December",
                ]
                .iter()
                .map(|m| format!("<{m}/>"))
                .collect();
                format!("<ScheduleByMonth><DaysOfMonth><Day>1</Day></DaysOfMonth><Months>{months}</Months></ScheduleByMonth>")
            }
            _ => "<ScheduleByWeek><DaysOfWeek><Monday/></DaysOfWeek><WeeksInterval>1</WeeksInterval></ScheduleByWeek>".to_string(),
        };
        format!("<CalendarTrigger><StartBoundary>{start}</StartBoundary><Enabled>true</Enabled>{sb}</CalendarTrigger>")
    }

    fn task_xml(s: &Sched, exe: &str) -> String {
        let args = format!("run-schedule {}", s.id);
        format!(
            "<?xml version=\"1.0\" encoding=\"UTF-16\"?>\n\
             <Task version=\"1.2\" xmlns=\"http://schemas.microsoft.com/windows/2004/02/mit/task\">\n\
             <RegistrationInfo><Description>INVESTigator: {desc}</Description></RegistrationInfo>\n\
             <Triggers>{trig}</Triggers>\n\
             <Principals><Principal id=\"Author\"><LogonType>InteractiveToken</LogonType><RunLevel>LeastPrivilege</RunLevel></Principal></Principals>\n\
             <Settings><StartWhenAvailable>true</StartWhenAvailable><Enabled>true</Enabled><MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy><DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries><StopIfGoingOnBatteries>false</StopIfGoingOnBatteries><AllowStartOnDemand>true</AllowStartOnDemand><ExecutionTimeLimit>PT1H</ExecutionTimeLimit></Settings>\n\
             <Actions Context=\"Author\"><Exec><Command>{cmd}</Command><Arguments>{a}</Arguments></Exec></Actions>\n\
             </Task>\n",
            desc = xml_escape(&s.name),
            trig = trigger_xml(&s.frequency, &s.time),
            cmd = xml_escape(exe),
            a = xml_escape(&args),
        )
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // Launched by a scheduled task as `investigator.exe run-schedule <id>`? Then run
    // headless: keep the window hidden, let the frontend run the digest, and exit.
    let args: Vec<String> = std::env::args().collect();
    let sched_id = args
        .iter()
        .position(|a| a == "run-schedule")
        .and_then(|i| args.get(i + 1).cloned());
    let headless = sched_id.is_some();

    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_http::init())
        .plugin(tauri_plugin_sql::Builder::default().build())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_os::init())
        .manage(LaunchTask(sched_id))
        .invoke_handler(tauri::generate_handler![
            send_email,
            sync_schedules,
            pending_scheduled_run,
            exit_app
        ])
        .setup(move |app| {
            // The main window is configured hidden; show it only for a normal launch.
            if !headless {
                if let Some(w) = app.get_webview_window("main") {
                    let _ = w.show();
                }
            }
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
