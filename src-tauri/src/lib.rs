//! Thin command layer. Keep this file boring: argument marshalling only.
//! Anything with logic belongs in `media_server.rs` or `sidecar.rs`.

mod media_server;
mod sidecar;

use std::path::PathBuf;

use media_server::MediaServer;
use tauri::{Manager, State};

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
    let bin = yt_dlp_path(&app);

    tauri::async_runtime::spawn_blocking(move || -> Result<ResolvedResponse, String> {
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
    sidecar::probe(&yt_dlp_path(&app))
}

/// Prefer a sidecar bundled next to the executable; fall back to PATH in development.
fn yt_dlp_path(app: &tauri::AppHandle) -> PathBuf {
    let name = if cfg!(windows) { "yt-dlp.exe" } else { "yt-dlp" };
    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            let candidate = dir.join(name);
            if candidate.is_file() {
                return candidate;
            }
        }
    }
    let _ = app;
    PathBuf::from(name)
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
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            register_local_file,
            resolve_track,
            resolver_health
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
