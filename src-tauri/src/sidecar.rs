//! yt-dlp invocation.
//!
//! This file is a security boundary and is meant to be read line by line.
//!
//! Rules enforced here:
//!   * never a shell; argv is a Vec<String>, so no metacharacter interpretation
//!   * `--` terminates options, so a caller-supplied value can never become a flag
//!   * the URL is validated against a strict host allowlist before it is seen by yt-dlp
//!   * `--no-config` and `--no-cache-dir` keep user/global yt-dlp config out of the
//!     process (a poisoned config file is a real supply-chain vector)
//!   * the returned path must resolve inside our cache directory

use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

use url::Url;

const ALLOWED_HOSTS: &[&str] = &[
    "youtube.com",
    "www.youtube.com",
    "m.youtube.com",
    "music.youtube.com",
    "youtu.be",
];

/// audio container formats the media server and both webviews can play
const ALLOWED_EXTS: &[&str] = &["m4a", "mp4", "mp3", "flac", "wav", "ogg", "opus", "aac"];

#[derive(Debug, serde::Serialize)]
pub struct ResolvedTrack {
    pub path: String,
    pub title: String,
    pub duration: f64,
    pub video_id: String,
}

pub fn validate_url(raw: &str) -> Result<Url, String> {
    let candidate = raw.trim();
    if candidate.is_empty() {
        return Err("empty URL".into());
    }
    // The URL parser happily percent-encodes spaces, so a value like
    // "https://youtube.com/watch?v=x --exec=..." parses successfully. It is harmless
    // once `--` terminates options, but ambiguity at the boundary is worth refusing.
    if candidate.chars().any(|c| c.is_whitespace() || c.is_control()) {
        return Err("URLs may not contain whitespace or control characters".into());
    }
    let url = Url::parse(candidate).map_err(|e| format!("not a URL: {e}"))?;
    if url.scheme() != "https" {
        return Err("only https URLs are accepted".into());
    }
    if !url.username().is_empty() || url.password().is_some() {
        return Err("credentials in URLs are not accepted".into());
    }
    match url.port() {
        None | Some(443) => {}
        Some(_) => return Err("non-standard ports are not accepted".into()),
    }
    let host = url.host_str().ok_or("URL has no host")?.to_ascii_lowercase();
    if !ALLOWED_HOSTS.contains(&host.as_str()) {
        return Err(format!("host not allowed: {host}"));
    }
    Ok(url)
}

pub fn resolve_audio(bin: &Path, raw_url: &str, cache_dir: &Path) -> Result<ResolvedTrack, String> {
    let url = validate_url(raw_url)?;
    std::fs::create_dir_all(cache_dir).map_err(|e| format!("cache dir: {e}"))?;

    let out_template = format!("{}/%(id)s.%(ext)s", cache_dir.display());
    let args: Vec<String> = vec![
        "--no-config".into(),
        "--no-cache-dir".into(),
        "--no-playlist".into(),
        "--no-warnings".into(),
        "--no-progress".into(),
        "--socket-timeout".into(),
        "15".into(),
        "--retries".into(),
        "2".into(),
        "--fragment-retries".into(),
        "2".into(),
        "-f".into(),
        "bestaudio[ext=m4a]/bestaudio".into(),
        "-o".into(),
        out_template,
        "--print".into(),
        "MALICE_TITLE=%(title)s".into(),
        "--print".into(),
        "MALICE_DURATION=%(duration)s".into(),
        "--print".into(),
        "MALICE_ID=%(id)s".into(),
        // after_move stages print last, so fields are tagged rather than positional.
        "--print".into(),
        "after_move:MALICE_PATH=%(filepath)s".into(),
        "--".into(),
        url.to_string(),
    ];

    let mut command = Command::new(bin);
    command
        .args(&args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        command.creation_flags(CREATE_NO_WINDOW);
    }

    let output = command.output().map_err(|e| format!("could not run yt-dlp: {e}"))?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        let tail: Vec<&str> = stderr.lines().rev().take(3).collect();
        return Err(format!("yt-dlp failed: {}", tail.into_iter().rev().collect::<Vec<_>>().join(" | ")));
    }

    let stdout = String::from_utf8_lossy(&output.stdout);
    let (path, title, duration, video_id) = parse_print_output(&stdout)?;
    let file = PathBuf::from(&path);
    let canonical_file = file.canonicalize().map_err(|e| format!("resolved file missing: {e}"))?;
    let canonical_cache = cache_dir.canonicalize().map_err(|e| format!("cache dir: {e}"))?;
    if !canonical_file.starts_with(&canonical_cache) {
        return Err("yt-dlp wrote outside the cache directory".into());
    }
    let ext = canonical_file
        .extension()
        .and_then(|e| e.to_str())
        .map(str::to_ascii_lowercase)
        .unwrap_or_default();
    if !ALLOWED_EXTS.contains(&ext.as_str()) {
        return Err(format!("unexpected media container: {ext}"));
    }

    Ok(ResolvedTrack {
        path: canonical_file.to_string_lossy().into_owned(),
        title,
        duration,
        video_id,
    })
}

/// Field order from `--print` is not stable: the `after_move` stage prints last.
/// Tagged fields make the parse order-independent.
fn parse_print_output(stdout: &str) -> Result<(String, String, f64, String), String> {
    let mut path = None;
    let mut title = None;
    let mut duration = None;
    let mut id = None;

    for line in stdout.lines() {
        let line = line.trim();
        if let Some(v) = line.strip_prefix("MALICE_PATH=") {
            path = Some(v.to_string());
        } else if let Some(v) = line.strip_prefix("MALICE_TITLE=") {
            title = Some(v.to_string());
        } else if let Some(v) = line.strip_prefix("MALICE_DURATION=") {
            duration = Some(v.parse::<f64>().unwrap_or(0.0));
        } else if let Some(v) = line.strip_prefix("MALICE_ID=") {
            id = Some(v.to_string());
        }
    }

    let path = path.ok_or("yt-dlp did not report a file path")?;
    if path.is_empty() || path == "NA" {
        return Err("yt-dlp reported no output file".into());
    }
    Ok((
        path,
        title.unwrap_or_else(|| "unknown title".into()),
        duration.unwrap_or(0.0),
        id.unwrap_or_default(),
    ))
}

pub fn is_supported_audio(path: &Path) -> bool {
    path.extension()
        .and_then(|e| e.to_str())
        .map(str::to_ascii_lowercase)
        .map(|e| ALLOWED_EXTS.contains(&e.as_str()))
        .unwrap_or(false)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_non_youtube_hosts() {
        assert!(validate_url("https://example.com/watch?v=x").is_err());
        assert!(validate_url("https://youtube.com.evil.tld/watch?v=x").is_err());
        assert!(validate_url("https://user:pw@youtube.com/watch?v=x").is_err());
        assert!(validate_url("http://youtube.com/watch?v=x").is_err());
        assert!(validate_url("file:///etc/passwd").is_err());
        assert!(validate_url("https://youtube.com:8443/watch?v=x").is_err());
    }

    #[test]
    fn accepts_canonical_watch_urls() {
        assert!(validate_url("https://www.youtube.com/watch?v=dQw4w9WgXcQ").is_ok());
        assert!(validate_url("https://youtu.be/dQw4w9WgXcQ").is_ok());
        assert!(validate_url("https://music.youtube.com/watch?v=dQw4w9WgXcQ").is_ok());
    }

    /// The regression test for the bug that is easiest to ship by accident:
    /// a query or URL that looks like a flag must never be reinterpreted as one.
    #[test]
    fn flag_shaped_input_is_not_accepted_as_a_url() {
        assert!(validate_url("--exec=touch /tmp/owned").is_err());
        assert!(validate_url("-o/tmp/owned").is_err());
        assert!(validate_url("https://www.youtube.com/watch?v=x --exec=touch /tmp/owned").is_err());
    }

    /// Real yt-dlp output: the after_move stage prints last, not first.
    #[test]
    fn print_output_is_parsed_regardless_of_field_order() {
        let stdout = "\
MALICE_TITLE=Rick Astley - Never Gonna Give You Up (Official Video) (4K Remaster)
MALICE_DURATION=213
MALICE_ID=dQw4w9WgXcQ
MALICE_PATH=/tmp/malice-cache/dQw4w9WgXcQ.m4a
";
        let (path, title, duration, id) = parse_print_output(stdout).unwrap();
        assert_eq!(path, "/tmp/malice-cache/dQw4w9WgXcQ.m4a");
        assert!(title.starts_with("Rick Astley"));
        assert_eq!(duration, 213.0);
        assert_eq!(id, "dQw4w9WgXcQ");
    }

    #[test]
    fn missing_path_is_an_error_not_a_guess() {
        let stdout = "MALICE_TITLE=x\nMALICE_DURATION=1\nMALICE_ID=abc\n";
        assert!(parse_print_output(stdout).is_err());
        let failed_move = "MALICE_PATH=NA\nMALICE_TITLE=x\n";
        assert!(parse_print_output(failed_move).is_err());
    }
}
