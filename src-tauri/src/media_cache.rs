//! Managed media cache.
//!
//! Only regular files directly inside the app's media cache directory are candidates.
//! Downloads in progress (`*.part`, `*.ytdl`) and caller-protected paths are never
//! deleted. `cache_evict` reports what it removed so the media server can forget those
//! ids instead of serving a file that no longer exists.

use std::fs;
use std::io;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CacheStats {
    pub bytes: u64,
    pub files: u64,
    pub cap_bytes: u64,
}

struct Entry {
    path: PathBuf,
    bytes: u64,
    modified: SystemTime,
}

/// Current usage. A missing cache directory is an empty cache, not an error.
pub fn stats(dir: &Path, cap_bytes: u64) -> CacheStats {
    let entries = managed_entries(dir).unwrap_or_default();
    CacheStats {
        bytes: entries.iter().map(|entry| entry.bytes).sum(),
        files: entries.len() as u64,
        cap_bytes,
    }
}

/// Evict oldest-first until under `cap_bytes`, skipping `keep_paths`.
///
/// `on_evict` is called only after a delete succeeds, so callers can invalidate the
/// matching media-server ids without racing a failed unlink.
pub fn evict<F>(dir: &Path, cap_bytes: u64, keep_paths: &[String], mut on_evict: F) -> CacheStats
where
    F: FnMut(&Path),
{
    let mut entries = match managed_entries(dir) {
        Ok(entries) => entries,
        Err(_) => {
            return CacheStats {
                bytes: 0,
                files: 0,
                cap_bytes,
            }
        }
    };

    entries.sort_by(|a, b| a.modified.cmp(&b.modified).then_with(|| a.path.cmp(&b.path)));

    let keep: Vec<PathBuf> = keep_paths
        .iter()
        .map(|path| canonical_or_original(Path::new(path)))
        .collect();

    let mut bytes: u64 = entries.iter().map(|entry| entry.bytes).sum();
    let mut files = entries.len() as u64;

    for entry in &entries {
        if bytes <= cap_bytes {
            break;
        }
        if is_kept(&entry.path, &keep) {
            continue;
        }
        if fs::remove_file(&entry.path).is_ok() {
            bytes = bytes.saturating_sub(entry.bytes);
            files = files.saturating_sub(1);
            on_evict(&entry.path);
        }
    }

    CacheStats {
        bytes,
        files,
        cap_bytes,
    }
}

fn managed_entries(dir: &Path) -> io::Result<Vec<Entry>> {
    let mut entries = Vec::new();

    for item in fs::read_dir(dir)? {
        let item = item?;
        let path = item.path();
        let metadata = fs::symlink_metadata(&path)?;

        // Regular files only: this skips directories and symlinks (never follow a link
        // out of the cache directory).
        if !metadata.file_type().is_file() {
            continue;
        }

        let extension = path.extension().and_then(|value| value.to_str()).unwrap_or("");
        if extension.eq_ignore_ascii_case("part") || extension.eq_ignore_ascii_case("ytdl") {
            continue;
        }

        entries.push(Entry {
            path,
            bytes: metadata.len(),
            modified: metadata.modified().unwrap_or(UNIX_EPOCH),
        });
    }

    Ok(entries)
}

fn is_kept(path: &Path, keep: &[PathBuf]) -> bool {
    let canonical = canonical_or_original(path);
    keep.iter().any(|candidate| candidate == &canonical || candidate == path)
}

fn canonical_or_original(path: &Path) -> PathBuf {
    fs::canonicalize(path).unwrap_or_else(|_| path.to_path_buf())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs::File;
    use std::sync::atomic::{AtomicU64, Ordering};
    use std::time::Duration;

    static COUNTER: AtomicU64 = AtomicU64::new(0);

    fn unique_dir(label: &str) -> PathBuf {
        let unique = COUNTER.fetch_add(1, Ordering::Relaxed);
        let dir = std::env::temp_dir().join(format!(
            "malice-media-cache-{label}-{}-{unique}",
            std::process::id()
        ));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn write_file(dir: &Path, name: &str, bytes: usize, modified_secs: u64) -> PathBuf {
        let path = dir.join(name);
        fs::write(&path, vec![0u8; bytes]).unwrap();
        let file = File::options().write(true).open(&path).unwrap();
        file.set_modified(UNIX_EPOCH + Duration::from_secs(modified_secs))
            .unwrap();
        path
    }

    #[test]
    fn evicts_oldest_files_until_under_the_cap() {
        let dir = unique_dir("oldest");
        let oldest = write_file(&dir, "oldest.m4a", 400, 10);
        let middle = write_file(&dir, "middle.m4a", 400, 20);
        let newest = write_file(&dir, "newest.m4a", 400, 30);
        let partial = write_file(&dir, "downloading.part", 5_000, 1);

        let stats = evict(&dir, 500, &[], |_| {});

        assert_eq!(stats.bytes, 400);
        assert_eq!(stats.files, 1);
        assert_eq!(stats.cap_bytes, 500);
        assert!(!oldest.exists());
        assert!(!middle.exists());
        assert!(newest.exists());
        assert!(partial.exists(), "*.part must never be evicted");
        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn protected_paths_survive_even_when_the_cap_is_exceeded() {
        let dir = unique_dir("protected");
        let oldest = write_file(&dir, "oldest.m4a", 400, 10);
        let protected = write_file(&dir, "playing.m4a", 400, 20);
        let newest = write_file(&dir, "newest.m4a", 400, 30);
        let keep = vec![protected.to_string_lossy().into_owned()];

        let stats = evict(&dir, 500, &keep, |_| {});

        assert!(!oldest.exists());
        assert!(protected.exists(), "the playing file must survive");
        assert!(!newest.exists());
        assert_eq!(stats.bytes, 400);
        assert_eq!(stats.files, 1);
        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn all_protected_paths_can_leave_the_cache_over_cap() {
        let dir = unique_dir("all-protected");
        let first = write_file(&dir, "first.m4a", 400, 10);
        let second = write_file(&dir, "second.m4a", 400, 20);
        let keep = vec![
            first.to_string_lossy().into_owned(),
            second.to_string_lossy().into_owned(),
        ];

        let stats = evict(&dir, 100, &keep, |_| {});

        assert!(first.exists());
        assert!(second.exists());
        assert_eq!(stats.bytes, 800);
        assert_eq!(stats.files, 2);
        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn ignores_partial_downloads_and_files_it_did_not_create() {
        let dir = unique_dir("ignored");
        let partial = write_file(&dir, "one.part", 100, 10);
        let metadata = write_file(&dir, "two.ytdl", 100, 20);
        let nested_dir = dir.join("nested");
        fs::create_dir_all(&nested_dir).unwrap();
        let nested = nested_dir.join("inside.m4a");
        fs::write(&nested, vec![0u8; 100]).unwrap();

        let before = stats(&dir, 0);
        assert_eq!(before.bytes, 0);
        assert_eq!(before.files, 0);

        let stats = evict(&dir, 0, &[], |_| {});

        assert_eq!(stats.bytes, 0);
        assert_eq!(stats.files, 0);
        assert!(partial.exists());
        assert!(metadata.exists());
        assert!(nested.exists(), "subdirectories are outside the managed set");
        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn reports_each_deleted_path_to_the_caller() {
        let dir = unique_dir("reported");
        write_file(&dir, "a.m4a", 600, 10);
        write_file(&dir, "b.m4a", 600, 20);
        let mut evicted = Vec::new();

        evict(&dir, 100, &[], |path| evicted.push(path.to_path_buf()));

        assert_eq!(evicted.len(), 2);
        assert!(evicted.iter().all(|path| !path.exists()));
        fs::remove_dir_all(&dir).ok();
    }
}