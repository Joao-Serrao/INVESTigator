use std::sync::Mutex;
use tauri::{Manager, RunEvent};
use tauri_plugin_shell::process::CommandChild;
use tauri_plugin_shell::ShellExt;

// Holds the Python engine sidecar so we can stop it when the app closes.
struct Sidecar(Mutex<Option<CommandChild>>);

/// Kill engine processes via taskkill (no console window). The one-file engine
/// spawns a child, so child.kill() alone leaves an orphan — we kill the tree.
#[cfg(windows)]
fn taskkill(args: &[&str]) {
    use std::os::windows::process::CommandExt;
    let _ = std::process::Command::new("taskkill")
        .args(args)
        .creation_flags(0x08000000) // CREATE_NO_WINDOW
        .output();
}
#[cfg(not(windows))]
fn taskkill(_args: &[&str]) {}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .setup(|app| {
            if cfg!(debug_assertions) {
                app.handle().plugin(
                    tauri_plugin_log::Builder::default()
                        .level(log::LevelFilter::Info)
                        .build(),
                )?;
            }
            // Clean up any engine left over from a previous crash/force-kill so the
            // freshly-installed app always serves its own (current) engine.
            taskkill(&["/F", "/IM", "investraton-app.exe"]);
            // Start the bundled Python engine. The window shows a loading page that
            // polls the server and redirects once it's up.
            let (_rx, child) = app
                .shell()
                .sidecar("investraton-app")
                .expect("investraton-app sidecar should be configured")
                .spawn()
                .expect("failed to start the Investraton engine");
            app.manage(Sidecar(Mutex::new(Some(child))));
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building Investraton")
        .run(|app, event| {
            // Stop the engine (and its child process) whenever the app exits.
            if matches!(event, RunEvent::ExitRequested { .. } | RunEvent::Exit) {
                if let Some(state) = app.try_state::<Sidecar>() {
                    let _ = state.0.lock().unwrap().take();
                }
                // Kill by image name: the one-file engine has a bootstrapper + child,
                // so killing the tree by name guarantees no orphan is left on the port.
                taskkill(&["/F", "/IM", "investraton-app.exe"]);
            }
        });
}
