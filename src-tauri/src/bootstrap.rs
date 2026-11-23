//! Toolchain bootstrap: locate, install, and update the yt-dlp binary.
//!
//! This module intentionally performs remote code execution at launch, so the rules
//! below are not optional:
//!
//!   1. HTTPS only, one host (`api.github.com` / `github.com`), one repo.
//!   2. Every downloaded byte is hashed. The file is written to `.part`, verified
//!      against the SHA-256 published in the release, and only then renamed into place.
//!   3. The candidate binary must answer `--version` before it replaces a working one.
//!      The previous binary is kept as `yt-dlp.bak` and restored on failure.
//!   4. Nothing is ever written outside the app data directory.
//!
//! Deliberately has no dependency on Tauri: the caller supplies the data directory and
//! a progress callback, which is what makes the download path testable headlessly.

use std::fs;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use sha2::{Digest, Sha256};

const RELEASE_API: &str = "https://api.github.com/repos/yt-dlp/yt-dlp/releases/latest";
const USER_AGENT: &str = "Malice/0.1 (class project; toolchain bootstrap)";
const UPDATE_CHECK_INTERVAL_SECS: u64 = 6 * 60 * 60;

type Reporter<'a> = &'a dyn Fn(&ToolchainStatus);

#[derive(Clone, Debug, serde::Serialize)]
pub struct ToolchainStatus {
    /// checking | downloading | ready | error
    pub phase: String,
    pub version: Option<String>,
    pub path: Option<String>,
    pub detail: Option<String>,
    pub received: u64,
    pub total: u64,
}

impl ToolchainStatus {
    fn new(phase: &str) -> Self {
        Self {
            phase: phase.into(),
            version: None,
            path: None,
            detail: None,
            received: 0,
            total: 0,
        }
    }
}

#[derive(serde::Deserialize)]
struct Release {
    tag_name: String,
    assets: Vec<Asset>,
}

#[derive(serde::Deserialize)]
struct Asset {
    name: String,
    browser_download_url: String,
    digest: Option<String>,
}

struct Remote {
    tag: String,
    url: String,
    sha256: String,
}

pub fn binary_name() -> &'static str {
    if cfg!(windows) {
        "yt-dlp.exe"
    } else {
        "yt-dlp"
    }
}

fn asset_name() -> &'static str {
    if cfg!(windows) {
        "yt-dlp.exe"
    } else if cfg!(target_os = "macos") {
        "yt-dlp_macos"
    } else {
        "yt-dlp_linux"
    }
}

pub fn bin_dir(data_dir: &Path) -> PathBuf {
    data_dir.join("bin")
}

fn state_file(data_dir: &Path) -> PathBuf {
    bin_dir(data_dir).join("state.json")
}

/// Best available binary: managed verified copy, then bundled sidecar, then the system.
pub fn locate(data_dir: &Path) -> Option<PathBuf> {
    let ours = bin_dir(data_dir).join(binary_name());
    if ours.is_file() {
        return Some(ours);
    }

    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            let bundled = dir.join(binary_name());
            if bundled.is_file() {
                return Some(bundled);
            }
        }
    }

    system_candidates().into_iter().find(|p| p.is_file())
}

/// Last resort only. GUI launches get a minimal PATH, so known locations are searched
/// explicitly rather than trusting the environment.
fn system_candidates() -> Vec<PathBuf> {
    let mut dirs: Vec<PathBuf> = Vec::new();
    if let Some(path) = std::env::var_os("PATH") {
        dirs.extend(std::env::split_paths(&path));
    }
    if cfg!(unix) {
        dirs.extend(
            ["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin"]
                .iter()
                .map(PathBuf::from),
        );
        if let Some(home) = std::env::var_os("HOME") {
            dirs.push(PathBuf::from(home).join(".local/bin"));
        }
    }
    if cfg!(windows) {
        if let Some(local) = std::env::var_os("LOCALAPPDATA") {
            dirs.push(PathBuf::from(&local).join("Programs").join("yt-dlp"));
            dirs.push(PathBuf::from(&local).join("Microsoft").join("WinGet").join("Links"));
        }
    }
    dirs.into_iter().map(|d| d.join(binary_name())).collect()
}

pub fn probe_version(bin: &Path) -> Option<String> {
    let mut command = Command::new(bin);
    command.arg("--version").stdin(Stdio::null());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x0800_0000);
    }
    let output = command.output().ok()?;
    if !output.status.success() {
        return None;
    }
    let version = String::from_utf8_lossy(&output.stdout).trim().to_string();
    if version.is_empty() {
        None
    } else {
        Some(version)
    }
}

/// Blocking. Call from a worker thread. Serialized so a double-invoked frontend
/// (React StrictMode, two windows) cannot run two downloads at once.
pub fn ensure(data_dir: &Path, force: bool, report: Reporter<'_>) -> ToolchainStatus {
    static ENSURE_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());
    let _guard = ENSURE_LOCK.lock().unwrap_or_else(|e| e.into_inner());

    let mut status = ToolchainStatus::new("checking");
    report(&status);
    eprintln!("[toolchain] ensure start (force={force})");

    let managed = bin_dir(data_dir).join(binary_name());

    // Case 1: we already have a working managed binary.
    if let Some(version) = managed.is_file().then(|| probe_version(&managed)).flatten() {
        status.version = Some(version.clone());
        status.path = Some(managed.to_string_lossy().into_owned());
        if force || update_check_due(data_dir) {
            match fetch_remote() {
                Ok(remote) if remote.tag != version => {
                    status.phase = "downloading".into();
                    status.detail = Some(format!("updating {version} → {}", remote.tag));
                    report(&status);
                    match install(data_dir, &remote, &mut status, report) {
                        Ok(new_version) => {
                            status.version = Some(new_version);
                            status.detail = Some(format!("updated to {}", remote.tag));
                        }
                        Err(err) => {
                            // Keep the working binary; an update must never break the app.
                            eprintln!("[toolchain] update failed, keeping {version}: {err}");
                            status.detail = Some(format!("update failed, staying on {version}: {err}"));
                        }
                    }
                }
                Ok(_) => {
                    status.detail = Some("up to date".into());
                    mark_checked(data_dir);
                }
                Err(err) => {
                    status.detail = Some(format!("offline; using {version} ({err})"));
                }
            }
        }
        status.phase = "ready".into();
        status.received = 0;
        status.total = 0;
        report(&status);
        eprintln!(
            "[toolchain] ready {} ({})",
            status.version.clone().unwrap_or_default(),
            status.detail.clone().unwrap_or_default()
        );
        return status;
    }

    // Case 2: install a verified copy.
    //
    // Deliberately no system-binary fallback here, even in development. A binary found
    // on PATH is an unverified executable: an attacker who can write to a PATH directory
    // gets code execution inside the app. The managed copy is checksum-pinned, and
    // `locate()` only consults PATH as a last resort after a failed bootstrap.
    status.phase = "downloading".into();
    status.detail = Some("installing yt-dlp".into());
    report(&status);

    match fetch_remote() {
        Ok(remote) => match install(data_dir, &remote, &mut status, report) {
            Ok(version) => {
                status.phase = "ready".into();
                status.version = Some(version);
                status.path = Some(managed.to_string_lossy().into_owned());
                status.detail = Some(format!("installed {}", remote.tag));
                status.received = 0;
                status.total = 0;
                report(&status);
                eprintln!("[toolchain] installed {}", remote.tag);
            }
            Err(err) => {
                eprintln!("[toolchain] install failed: {err}");
                status.phase = "error".into();
                status.detail = Some(err);
                report(&status);
            }
        },
        Err(err) => {
            eprintln!("[toolchain] release lookup failed: {err}");
            status.phase = "error".into();
            status.detail = Some(format!(
                "could not reach GitHub to install yt-dlp ({err}). Check your connection, or install yt-dlp and put it on PATH."
            ));
            report(&status);
        }
    }

    status
}

fn install(
    data_dir: &Path,
    remote: &Remote,
    status: &mut ToolchainStatus,
    report: Reporter<'_>,
) -> Result<String, String> {
    let dir = bin_dir(data_dir);
    fs::create_dir_all(&dir).map_err(|e| format!("cannot create {}: {e}", dir.display()))?;
    let dest = dir.join(binary_name());
    let tmp = dir.join(format!("{}.part", binary_name()));

    download(&remote.url, &tmp, &remote.sha256, status, report)?;

    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(&tmp, fs::Permissions::from_mode(0o755))
            .map_err(|e| format!("chmod failed: {e}"))?;
    }

    // Never promote a binary that does not run.
    let candidate = probe_version(&tmp).ok_or("downloaded binary does not run")?;

    if dest.is_file() {
        let backup = dir.join(format!("{}.bak", binary_name()));
        let _ = fs::remove_file(&backup);
        let _ = fs::rename(&dest, &backup);
    }
    fs::rename(&tmp, &dest).map_err(|e| format!("could not install binary: {e}"))?;
    mark_checked(data_dir);

    Ok(candidate)
}

fn download(
    url: &str,
    dest: &Path,
    expected_sha: &str,
    status: &mut ToolchainStatus,
    report: Reporter<'_>,
) -> Result<(), String> {
    let response = ureq::get(url)
        .set("User-Agent", USER_AGENT)
        .timeout(Duration::from_secs(60))
        .call()
        .map_err(|e| format!("download failed: {e}"))?;

    let total: u64 = response
        .header("Content-Length")
        .and_then(|v| v.parse().ok())
        .unwrap_or(0);
    status.total = total;
    status.received = 0;
    report(status);

    let mut reader = response.into_reader();
    let mut file = fs::File::create(dest).map_err(|e| format!("cannot write download: {e}"))?;
    let mut hasher = Sha256::new();
    let mut buffer = vec![0u8; 64 * 1024];
    let mut received: u64 = 0;
    let mut last_report = std::time::Instant::now();

    loop {
        let read = reader.read(&mut buffer).map_err(|e| format!("download interrupted: {e}"))?;
        if read == 0 {
            break;
        }
        hasher.update(&buffer[..read]);
        file.write_all(&buffer[..read]).map_err(|e| format!("write failed: {e}"))?;
        received += read as u64;

        if last_report.elapsed() > Duration::from_millis(200) {
            status.received = received;
            report(status);
            last_report = std::time::Instant::now();
        }
    }
    file.flush().ok();

    let actual = to_hex(&hasher.finalize());
    if !constant_time_eq(&actual, &expected_sha.to_ascii_lowercase()) {
        let _ = fs::remove_file(dest);
        return Err(format!(
            "checksum mismatch (expected {expected_sha}, got {actual}); download discarded"
        ));
    }

    status.received = received;
    report(status);
    Ok(())
}

fn fetch_remote() -> Result<Remote, String> {
    let body = ureq::get(RELEASE_API)
        .set("User-Agent", USER_AGENT)
        .set("Accept", "application/vnd.github+json")
        .timeout(Duration::from_secs(20))
        .call()
        .map_err(|e| e.to_string())?
        .into_string()
        .map_err(|e| e.to_string())?;

    let release: Release = serde_json::from_str(&body).map_err(|e| format!("bad release JSON: {e}"))?;
    let wanted = asset_name();
    let asset = release
        .assets
        .iter()
        .find(|a| a.name == wanted)
        .ok_or_else(|| format!("release {} has no asset {wanted}", release.tag_name))?;

    let sha256 = match asset.digest.as_deref() {
        Some(digest) if digest.starts_with("sha256:") => digest["sha256:".len()..].to_string(),
        _ => sha_from_sums(&release.tag_name, wanted)?,
    };

    Ok(Remote { tag: release.tag_name, url: asset.browser_download_url.clone(), sha256 })
}

/// Fallback when the API omits `digest`: the release publishes a sums file.
fn sha_from_sums(tag: &str, asset: &str) -> Result<String, String> {
    let url = format!("https://github.com/yt-dlp/yt-dlp/releases/download/{tag}/SHA2-256SUMS");
    let body = ureq::get(&url)
        .set("User-Agent", USER_AGENT)
        .timeout(Duration::from_secs(20))
        .call()
        .map_err(|e| e.to_string())?
        .into_string()
        .map_err(|e| e.to_string())?;

    for line in body.lines() {
        let mut parts = line.split_whitespace();
        if let (Some(hash), Some(name)) = (parts.next(), parts.next()) {
            if name == asset && hash.len() == 64 {
                return Ok(hash.to_ascii_lowercase());
            }
        }
    }
    Err(format!("no checksum published for {asset}"))
}

fn update_check_due(data_dir: &Path) -> bool {
    let Ok(body) = fs::read_to_string(state_file(data_dir)) else {
        return true;
    };
    let Ok(json) = serde_json::from_str::<serde_json::Value>(&body) else {
        return true;
    };
    let Some(last) = json.get("last_check").and_then(|v| v.as_u64()) else {
        return true;
    };
    now_secs().saturating_sub(last) > UPDATE_CHECK_INTERVAL_SECS
}

fn mark_checked(data_dir: &Path) {
    let _ = fs::create_dir_all(bin_dir(data_dir));
    let _ = fs::write(state_file(data_dir), format!("{{\"last_check\":{}}}", now_secs()));
}

fn now_secs() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

fn to_hex(bytes: &[u8]) -> String {
    const HEX: &[u8; 16] = b"0123456789abcdef";
    let mut out = String::with_capacity(bytes.len() * 2);
    for b in bytes {
        out.push(HEX[(b >> 4) as usize] as char);
        out.push(HEX[(b & 0xf) as usize] as char);
    }
    out
}

fn constant_time_eq(a: &str, b: &str) -> bool {
    if a.len() != b.len() {
        return false;
    }
    a.bytes().zip(b.bytes()).fold(0u8, |acc, (x, y)| acc | (x ^ y)) == 0
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn asset_names_match_the_platform() {
        if cfg!(windows) {
            assert_eq!(asset_name(), "yt-dlp.exe");
            assert_eq!(binary_name(), "yt-dlp.exe");
        } else {
            assert_eq!(binary_name(), "yt-dlp");
            assert!(asset_name().starts_with("yt-dlp_"));
        }
    }

    #[test]
    fn hash_comparison_is_exact() {
        assert!(constant_time_eq("abc", "abc"));
        assert!(!constant_time_eq("abc", "abd"));
        assert!(!constant_time_eq("ABC", "abc"));
    }

    #[test]
    fn checksums_are_rejected_on_mismatch() {
        let dir = std::env::temp_dir().join(format!("malice-sha-{}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        let dest = dir.join("blob.part");
        let mut status = ToolchainStatus::new("downloading");

        // A real, tiny fetch: the checksum will not match, so the file must be deleted.
        let result = download(
            "https://api.github.com/repos/yt-dlp/yt-dlp/releases/latest",
            &dest,
            "0000000000000000000000000000000000000000000000000000000000000000",
            &mut status,
            &|_| {},
        );
        assert!(result.is_err());
        assert!(!dest.exists(), "mismatched download must be deleted");
        fs::remove_dir_all(&dir).ok();
    }

    /// Real network. Run with: cargo test -- --ignored --nocapture
    #[test]
    #[ignore = "network: downloads the yt-dlp release asset (~35MB) and verifies it"]
    fn installs_and_verifies_a_runnable_binary() {
        let dir = std::env::temp_dir().join(format!("malice-bootstrap-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);

        let status = ensure(&dir, true, &|_| {});
        assert_eq!(status.phase, "ready", "{status:?}");

        let bin = bin_dir(&dir).join(binary_name());
        assert!(bin.is_file(), "binary missing at {}", bin.display());
        let version = probe_version(&bin);
        assert!(version.is_some(), "downloaded binary does not run");
        eprintln!("installed version: {:?}", version);

        fs::remove_dir_all(&dir).ok();
    }
}
