//! INVESTigator desktop shell.
//!
//! The whole engine lives in TypeScript and runs in the WebView; Rust's only jobs
//! are to (1) register the four plugins the engine's platform adapter talks to, and
//! (2) provide the two things a WebView can't do itself: send SMTP email and (later)
//! register OS scheduled tasks. Everything else — ingestion, scoring, look-through,
//! narrative, history — is the same TypeScript that the parity harnesses verify.

use serde::Deserialize;

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

/// Register enabled schedules with the OS scheduler. The Windows Task Scheduler
/// port (schtasks, mirroring scheduler.py) lands with Stage 6; until then this is a
/// no-op so the settings UI's "sync" button reports cleanly rather than erroring.
#[tauri::command]
fn sync_schedules() -> serde_json::Value {
    serde_json::json!({ "ok": true, "results": [] })
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_http::init())
        .plugin(tauri_plugin_sql::Builder::default().build())
        .invoke_handler(tauri::generate_handler![send_email, sync_schedules])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
