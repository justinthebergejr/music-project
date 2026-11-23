//! Thin command layer. Keep this file boring: argument marshalling only.
//! Anything with logic belongs in `media_server.rs`, `sidecar.rs`, or `bootstrap.rs`.

mod bootstrap;
mod library_fs;
mod media_cache;
mod media_server;
mod sidecar;

use std::fs;
use std::io::ErrorKind;
use std::path::PathBuf;

use bootstrap::ToolchainStatus;
use media_server::MediaServer;
use tauri::{Emitter, Manager, State};

/// The library document is small. A larger value is either corruption or a caller
/// trying to make the app allocate without bound.
const MAX_LIBRARY_BYTES: u64 = 16 * 1024 * 1024;

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
    /// Canonical cache path. Used only to protect the file currently playing from LRU
    /// eviction; the webview still reads media through the loopback id, never this path.
    path: String,
}

/// Resolve a path the user just picked in a native dialog to a loopback URL.
#[tauri::command]
fn register_local_file(state: State<'_, AppState>, path: String) -> Result<String, String> {
    let canonical = canonicalize_local_file(path)?;
    let id = state.media.register(PathBuf::from(canonical));
    Ok(state.media.url_for(&id))
}

/// Canonicalize a local audio path without registering it for playback.
///
/// The library hashes this exact value to derive a deterministic `local:<sha256>` id.
/// Keeping canonicalization in Rust means the id does not depend on how the dialog
/// spelled the path (symlinks, `..`, case-preserving aliases).
#[tauri::command]
fn canonicalize_local_file(path: String) -> Result<String, String> {
    let path = PathBuf::from(path);
    if !path.is_file() {
        return Err("not a file".into());
    }
    let canonical = path.canonicalize().map_err(|e| format!("cannot resolve path: {e}"))?;
    if !sidecar::is_supported_audio(&canonical) {
        return Err("unsupported audio format".into());
    }
    Ok(canonical.to_string_lossy().into_owned())
}

/// Read the library document. `None` means "first launch" rather than an error.
#[tauri::command]
fn library_read(app: tauri::AppHandle, path: String) -> Result<Option<String>, String> {
    let path = validate_library_path(&app, &path)?;
    if path.exists() {
        let size = fs::metadata(&path).map_err(|e| format!("library metadata: {e}"))?.len();
        if size > MAX_LIBRARY_BYTES {
            return Err("library file is unexpectedly large".into());
        }
    }
    match fs::read_to_string(&path) {
        Ok(text) => Ok(Some(text)),
        Err(error) if error.kind() == ErrorKind::NotFound => Ok(None),
        Err(error) => Err(format!("cannot read library: {error}")),
    }
}

/// Atomically replace the library document. The old document survives every failure.
#[tauri::command]
fn library_write(app: tauri::AppHandle, path: String, contents: String) -> Result<(), String> {
    let path = validate_library_path(&app, &path)?;
    if contents.len() as u64 > MAX_LIBRARY_BYTES {
        return Err("library document is too large".into());
    }
    library_fs::atomic_write(&path, contents.as_bytes())
        .map_err(|e| format!("cannot write library: {e}"))
}

/// Preserve an unsupported document before the app falls back to defaults.
#[tauri::command]
fn library_backup(app: tauri::AppHandle, path: String) -> Result<(), String> {
    let path = validate_library_path(&app, &path)?;
    if !path.exists() {
        return Ok(());
    }
    let backup = path.with_file_name("library.json.bak");
    fs::copy(&path, &backup).map_err(|e| format!("cannot back up library: {e}"))?;
    Ok(())
}

/// Only `library.json` directly inside the app data directory is addressable.
///
/// The path arrives from the frontend (which got it from Tauri's path API), so it is
/// untrusted input even though it is usually correct. Refusing symlinks keeps a local
/// attacker from turning the library reader into an arbitrary-file reader.
fn validate_library_path(app: &tauri::AppHandle, raw: &str) -> Result<PathBuf, String> {
    let data_dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("no app data directory: {e}"))?;
    fs::create_dir_all(&data_dir).map_err(|e| format!("cannot create app data directory: {e}"))?;

    let requested = PathBuf::from(raw);
    if requested.file_name().and_then(|name| name.to_str()) != Some("library.json") {
        return Err("only library.json may be accessed".into());
    }

    let parent = requested.parent().ok_or("library path has no parent")?;
    let canonical_data = data_dir
        .canonicalize()
        .map_err(|e| format!("cannot resolve app data directory: {e}"))?;
    let canonical_parent = parent
        .canonicalize()
        .map_err(|e| format!("library directory unavailable: {e}"))?;
    if canonical_parent != canonical_data {
        return Err("library path must be inside the app data directory".into());
    }

    let path = canonical_data.join("library.json");
    if let Ok(metadata) = fs::symlink_metadata(&path) {
        if metadata.file_type().is_symlink() {
            return Err("library.json must not be a symlink".into());
        }
    }
    Ok(path)
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
            path: resolved.path,
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

/// Current managed-cache usage. The cap is supplied by the frontend so the policy has
/// one obvious home (`core/platform/cache.ts`).
#[tauri::command]
async fn cache_stats(
    state: State<'_, AppState>,
    cap_bytes: u64,
) -> Result<media_cache::CacheStats, String> {
    let dir = state.cache_dir.clone();
    drop(state);
    tauri::async_runtime::spawn_blocking(move || media_cache::stats(&dir, cap_bytes))
        .await
        .map_err(|e| format!("cache task failed: {e}"))
}

/// Evict oldest cached media until under `cap_bytes`, then forget their media-server
/// ids so a stale URL 404s instead of serving a deleted file.
#[tauri::command]
async fn cache_evict(
    state: State<'_, AppState>,
    cap_bytes: u64,
    keep_paths: Vec<String>,
) -> Result<media_cache::CacheStats, String> {
    let dir = state.cache_dir.clone();
    let media = state.media.clone();
    drop(state);

    tauri::async_runtime::spawn_blocking(move || {
        let mut evicted: Vec<PathBuf> = Vec::new();
        let stats = media_cache::evict(&dir, cap_bytes, &keep_paths, |path| {
            evicted.push(path.to_path_buf());
        });
        media.forget_paths(&evicted);
        stats
    })
    .await
    .map_err(|e| format!("cache task failed: {e}"))
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
            canonicalize_local_file,
            library_read,
            library_write,
            library_backup,
            toolchain_ensure,
            toolchain_status,
            resolve_track,
            resolver_health,
            cache_stats,
            cache_evict
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
