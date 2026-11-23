//! Thin command layer. Keep this file boring: argument marshalling only.
//! Anything with logic belongs in `media_server.rs`, `sidecar.rs`, or `bootstrap.rs`.

mod bootstrap;
mod media_server;
mod sidecar;

use std::path::PathBuf;

use bootstrap::ToolchainStatus;
use media_server::MediaServer;
use tauri::{Emitter, Manager, State};

struct AppState {
    media: MediaServer,
    cache_dir: PathBuf,
}

#[derive(serde::Serialize)]
struct ResolvedResponse {
    url: String,
    title: String,
    duration: f64,
    video_id: String,
}

/// Resolve a path the user just picked in a native dialog to a loopback URL.
#[tauri::command]
fn register_local_file(state: State<'_, AppState>, path: String) -> Result<String, String> {
    let path = PathBuf::from(path);
    if !path.is_file() {
        return Err("not a file".into());
    }
    let canonical = path.canonicalize().map_err(|e| format!("cannot resolve path: {e}"))?;
    if !sidecar::is_supported_audio(&canonical) {
        return Err("unsupported audio format".into());
    }
    let id = state.media.register(canonical);
    Ok(state.media.url_for(&id))
}

/// Launch-time bootstrap: install or update yt-dlp, verifying every downloaded byte.
/// Progress is streamed to the frontend on `toolchain://status`.
#[tauri::command]
async fn toolchain_ensure(app: tauri::AppHandle, force: bool) -> Result<ToolchainStatus, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let data_dir = app
            .path()
            .app_data_dir()
            .map_err(|e| format!("no app data directory: {e}"))?;
        let handle = app.clone();
        Ok(bootstrap::ensure(&data_dir, force, &move |status| {
            let _ = handle.emit("toolchain://status", status.clone());
        }))
    })
    .await
    .map_err(|e| format!("toolchain task failed: {e}"))?
}

/// Cheap synchronous view of what is available right now.
#[tauri::command]
fn toolchain_status(app: tauri::AppHandle) -> ToolchainStatus {
    let data_dir = match app.path().app_data_dir() {
        Ok(dir) => dir,
        Err(_) => {
            return ToolchainStatus {
                phase: "error".into(),
                version: None,
                path: None,
                detail: Some("no app data directory".into()),
                received: 0,
                total: 0,
            }
        }
    };

    match bootstrap::locate(&data_dir) {
        Some(path) => {
            let version = bootstrap::probe_version(&path);
            ToolchainStatus {
                phase: if version.is_some() { "ready".into() } else { "error".into() },
                version,
                path: Some(path.to_string_lossy().into_owned()),
                detail: None,
                received: 0,
                total: 0,
            }
        }
        None => ToolchainStatus {
            phase: "checking".into(),
            version: None,
            path: None,
            detail: Some("yt-dlp not installed yet".into()),
            received: 0,
            total: 0,
        },
    }
}

/// Download (or reuse) a YouTube track into the cache and hand back a local URL.
///
/// Cache-then-play, deliberately: it gives the analyser real same-origin bytes, makes
/// seeking native, survives stream URL expiry, and doubles as the offline demo backup.
#[tauri::command]
async fn resolve_track(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    url: String,
) -> Result<ResolvedResponse, String> {
    let cache_dir = state.cache_dir.clone();
    let media = state.media.clone();

    tauri::async_runtime::spawn_blocking(move || -> Result<ResolvedResponse, String> {
        let data_dir = app
            .path()
            .app_data_dir()
            .map_err(|e| format!("no app data directory: {e}"))?;
        let bin = bootstrap::locate(&data_dir).ok_or("yt-dlp is not installed yet")?;
        let resolved = sidecar::resolve_audio(&bin, &url, &cache_dir)?;
        let id = media.register(PathBuf::from(&resolved.path));
        Ok(ResolvedResponse {
            url: media.url_for(&id),
            title: resolved.title,
            duration: resolved.duration,
            video_id: resolved.video_id,
        })
    })
    .await
    .map_err(|e| format!("resolver task failed: {e}"))?
}

#[tauri::command]
fn resolver_health(app: tauri::AppHandle) -> Result<String, String> {
    let data_dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    let bin = bootstrap::locate(&data_dir).ok_or("yt-dlp is not installed")?;
    bootstrap::probe_version(&bin).ok_or_else(|| "yt-dlp found but not runnable".to_string())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            let media = MediaServer::start()?;
            eprintln!("[media] serving on 127.0.0.1:{}", media.port());
            let cache_dir = app.path().app_cache_dir()?.join("media");
            std::fs::create_dir_all(&cache_dir)?;
            app.manage(AppState { media, cache_dir });

            // Install/repair the toolchain at launch, independent of the webview.
            // The UI subscribes to the same event and also receives the final status
            // from its own `toolchain_ensure` call, so a late subscriber loses nothing.
            let handle = app.handle().clone();
            std::thread::spawn(move || {
                let Ok(data_dir) = handle.path().app_data_dir() else {
                    eprintln!("[toolchain] no app data directory");
                    return;
                };
                let emitter = handle.clone();
                let status = bootstrap::ensure(&data_dir, false, &move |s| {
                    let _ = emitter.emit("toolchain://status", s.clone());
                });
                let _ = handle.emit("toolchain://status", status);
            });

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            register_local_file,
            toolchain_ensure,
            toolchain_status,
            resolve_track,
            resolver_health
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
