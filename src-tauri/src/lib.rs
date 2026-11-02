// SPDX-License-Identifier: GPL-3.0-or-later
mod comments;
pub mod docs;
pub mod launch;
mod native;
pub mod obsidian;
pub mod protocol;
mod raw_html;
pub mod render;
pub mod timing;
pub mod vault;

use docs::{Docs, OpenError, OpenedDoc, PendingPaths};
use launch::{Launch, MeasureOpen};
use serde_json::json;
use std::fs::OpenOptions;
use std::io::Write;
use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::time::Duration;
use tauri::webview::NewWindowResponse;
use tauri::{AppHandle, Emitter, Manager, State, WebviewWindow, WebviewWindowBuilder};

const MAIN_WINDOW: &str = "main";
const PROTOCOL: &str = "mochi";
const OPEN_PATHS_EVENT: &str = "open-paths";
const SHELL_COMMAND_EVENT: &str = "shell-command";
const EXTERNAL_SCHEMES: [&str; 3] = ["http", "https", "mailto"];
const SCHEME_END: char = ':';
// If the page never reports its first frame, the window still has to appear.
const FIRST_PAINT_DEADLINE: Duration = Duration::from_secs(5);
const FILETIME_TICKS_PER_MS: f64 = 10_000.0;

/// What this run of the app knows about its own start and about the measure in progress.
struct Session {
    created_ms: f64,
    main_ms: f64,
    measure_file: Option<String>,
    painted: AtomicBool,
    measure_open: Mutex<Option<MeasureOpen>>,
}

fn main_window(app: &AppHandle) -> Option<WebviewWindow> {
    app.get_webview_window(MAIN_WINDOW)
}

#[tauri::command]
async fn open_document(path: String, app: AppHandle) -> Result<OpenedDoc, OpenError> {
    docs::off_the_workers(move || app.state::<Docs>().open(&path)).await
}

#[tauri::command]
fn take_pending_paths(pending: State<'_, PendingPaths>) -> Vec<String> {
    pending.take()
}

fn is_external_url(url: &str) -> bool {
    let scheme = url.split_once(SCHEME_END).map_or("", |(scheme, _)| scheme);
    EXTERNAL_SCHEMES
        .iter()
        .any(|known| scheme.eq_ignore_ascii_case(known))
        && !url.chars().any(char::is_control)
}

#[tauri::command(async)]
fn open_external(url: String) -> Result<(), String> {
    if is_external_url(&url) {
        native::shell_open(&url)
    } else {
        Err("only web and mail links open outside the app".to_string())
    }
}

/// `ms`: when the page saw its first frame, in Unix milliseconds.
#[tauri::command]
fn first_paint(ms: f64, app: AppHandle, session: State<'_, Session>) {
    if let Some(window) = main_window(&app) {
        let _ = window.show();
        let _ = window.set_focus();
    }
    session.painted.store(true, Ordering::SeqCst);
    if let Some(file) = &session.measure_file {
        let report = json!({
            "file": file,
            "mainMs": session.main_ms,
            "paintMs": ms - session.created_ms,
            "shownMs": timing::now_unix_ms() - session.created_ms,
        });
        let _ = writeln!(std::io::stdout(), "{report}");
        app.exit(0);
    }
}

/// The page shows the file of `measure.ps1 -Warm`: adds the time since its launch to the results.
#[tauri::command]
fn measure_open_done(session: State<'_, Session>) -> Result<(), String> {
    let measure = session.measure_open.lock().unwrap().take();
    let Some(MeasureOpen { t0, out, .. }) = measure else {
        return Ok(());
    };
    let elapsed_ms = timing::now_filetime().saturating_sub(t0) as f64 / FILETIME_TICKS_PER_MS;
    OpenOptions::new()
        .create(true)
        .append(true)
        .open(out)
        .and_then(|mut file| writeln!(file, "{elapsed_ms:.1}"))
        .map_err(|error| error.to_string())
}

#[cfg(feature = "smoke")]
#[tauri::command(async)]
fn smoke_write_dump(out: String, json: String) -> Result<(), String> {
    std::fs::write(out, json).map_err(|error| error.to_string())
}

/// A second process passed on its command line: this one does what it was asked to.
fn on_second_instance(app: &AppHandle, argv: Vec<String>, cwd: String) {
    let launch = Launch::parse(argv.into_iter().skip(1), Path::new(&cwd));
    let session = app.state::<Session>();
    if let Some(out) = launch.dump_tabs {
        if cfg!(feature = "smoke") {
            let command = json!({ "action": "dump-tabs", "out": out });
            let _ = app.emit(SHELL_COMMAND_EVENT, command);
        }
        return;
    }
    if let Some(measure) = launch.measure_open {
        let command = json!({ "action": "measure-open", "path": measure.path });
        *session.measure_open.lock().unwrap() = Some(measure);
        let _ = app.emit(SHELL_COMMAND_EVENT, command);
    }
    if let Some(paths) = app.state::<PendingPaths>().add(launch.paths) {
        let _ = app.emit(OPEN_PATHS_EVENT, paths);
    }
    // Before the first frame the window is still hidden on purpose: `first_paint` will show it.
    if session.painted.load(Ordering::SeqCst) {
        if let Some(window) = main_window(app) {
            let _ = window.unminimize();
            let _ = window.set_focus();
        }
    }
}

fn create_window(app: &mut tauri::App) -> tauri::Result<()> {
    let config = app
        .config()
        .app
        .windows
        .first()
        .cloned()
        .expect("tauri.conf.json declares the window");
    let window = WebviewWindowBuilder::from_config(app.handle(), &config)?
        .on_navigation(|url| url.origin().ascii_serialization() == protocol::APP_ORIGIN)
        .on_new_window(|_, _| NewWindowResponse::Deny)
        .build()?;
    if let Ok(hwnd) = window.hwnd() {
        let _ = native::disable_open_animation(hwnd);
    }
    window.with_webview(|webview| {
        let _ = native::disable_browser_features(&webview.controller());
    })?;
    let handle = app.handle().clone();
    std::thread::spawn(move || {
        std::thread::sleep(FIRST_PAINT_DEADLINE);
        if !handle.state::<Session>().painted.load(Ordering::SeqCst) {
            if let Some(window) = main_window(&handle) {
                let _ = window.show();
            }
        }
    });
    Ok(())
}

pub fn run() {
    let created_ms = timing::process_created_unix_ms();
    let main_ms = timing::now_unix_ms() - created_ms;
    let gate = native::BootGate::acquire();

    let args = std::env::args_os()
        .skip(1)
        .map(|arg| arg.to_string_lossy().into_owned());
    let launch = Launch::parse(args, &std::env::current_dir().unwrap_or_default());
    let first_file = launch.paths.first().cloned();

    let docs = Docs::default();
    let roots = docs.roots();
    let pending = PendingPaths::default();
    pending.add(launch.paths);
    let session = Session {
        created_ms,
        main_ms,
        measure_file: first_file.clone().filter(|_| launch.measure),
        painted: AtomicBool::new(false),
        measure_open: Mutex::new(None),
    };

    let app = tauri::Builder::default()
        // Must stay the first plugin: a second instance exits inside it.
        .plugin(tauri_plugin_single_instance::init(on_second_instance))
        .manage(docs)
        .manage(pending)
        .manage(session)
        .register_asynchronous_uri_scheme_protocol(PROTOCOL, move |_, request, responder| {
            let roots = roots.clone();
            let path = request.uri().path().to_string();
            tauri::async_runtime::spawn_blocking(move || {
                responder.respond(protocol::respond(&roots, &path));
            });
        })
        .invoke_handler(tauri::generate_handler![
            open_document,
            take_pending_paths,
            open_external,
            first_paint,
            measure_open_done,
            #[cfg(feature = "smoke")]
            smoke_write_dump,
        ])
        .setup(|app| Ok(create_window(app)?))
        .build(tauri::generate_context!())
        .expect("the app could not start");
    drop(gate);

    // Not earlier: a second instance has already exited by here, and would have read the file for nothing.
    if let Some(file) = first_file {
        app.state::<Docs>().preload(&file);
    }
    app.run(|_, _| {});
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_web_and_mail_links_open_outside_the_app() {
        for url in [
            "http://e.org",
            "https://e.org/a?b",
            "HTTPS://E.ORG",
            "mailto:a@e.org",
        ] {
            assert!(is_external_url(url), "{url}");
        }
        for url in [
            "file:///C:/Windows/notepad.exe",
            "C:\\Windows\\notepad.exe",
            "ms-settings:display",
            "javascript:x()",
            "http",
            "",
            "https://e.org/\nx",
        ] {
            assert!(!is_external_url(url), "{url}");
        }
    }
}
