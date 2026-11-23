//! Crash-safe file writes for the library document.
//!
//! The invariant is simple: the target path is only ever produced by an atomic rename.
//! A crash can therefore leave the old document or the new one, never a prefix of either.
//! Keep this file free of Tauri types so it can be unit-tested headlessly.

use std::fs::{self, File, OpenOptions};
use std::io::{self, Write};
use std::path::{Path, PathBuf};

/// Write `bytes` to `path` atomically (temp file → fsync → rename → parent fsync).
pub fn atomic_write(path: &Path, bytes: &[u8]) -> io::Result<()> {
    atomic_write_with(path, |file| file.write_all(bytes))
}

/// The testable core of [`atomic_write`]: `write` may fail part-way through.
///
/// On any error the temp file is removed and the previous target is untouched.
pub fn atomic_write_with<F>(path: &Path, write: F) -> io::Result<()>
where
    F: FnOnce(&mut File) -> io::Result<()>,
{
    let parent = path
        .parent()
        .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidInput, "path has no parent"))?;
    fs::create_dir_all(parent)?;

    let temporary = temporary_path(path)?;
    let result = (|| {
        let mut file = OpenOptions::new()
            .write(true)
            .create(true)
            .truncate(true)
            .open(&temporary)?;
        write(&mut file)?;
        file.sync_all()?;
        drop(file);
        fs::rename(&temporary, path)?;
        sync_parent(parent);
        Ok(())
    })();

    if result.is_err() {
        let _ = fs::remove_file(&temporary);
    }
    result
}

fn temporary_path(path: &Path) -> io::Result<PathBuf> {
    let name = path
        .file_name()
        .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidInput, "path has no file name"))?;
    let mut temporary = name.to_os_string();
    temporary.push(".tmp");
    Ok(path.with_file_name(temporary))
}

/// Best effort: the rename is the durability boundary; the directory fsync makes the
/// rename itself durable across a power loss on Unix. Windows cannot open a directory
/// as a file, so it is skipped there.
#[cfg(unix)]
fn sync_parent(parent: &Path) {
    if let Ok(directory) = File::open(parent) {
        let _ = directory.sync_all();
    }
}

#[cfg(not(unix))]
fn sync_parent(_parent: &Path) {}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU64, Ordering};

    static COUNTER: AtomicU64 = AtomicU64::new(0);

    fn temp_dir(label: &str) -> PathBuf {
        let unique = COUNTER.fetch_add(1, Ordering::Relaxed);
        let dir = std::env::temp_dir().join(format!(
            "malice-library-fs-{label}-{}-{unique}",
            std::process::id()
        ));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn atomic_write_leaves_a_complete_file_and_no_temp() {
        let dir = temp_dir("complete");
        let path = dir.join("library.json");

        atomic_write(&path, b"{\"version\":1}").unwrap();

        assert_eq!(fs::read(&path).unwrap(), b"{\"version\":1}");
        assert!(!dir.join("library.json.tmp").exists());
        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn a_failed_write_never_truncates_the_previous_target() {
        let dir = temp_dir("failed");
        let path = dir.join("library.json");
        fs::write(&path, b"original document").unwrap();

        let error = atomic_write_with(&path, |file| {
            file.write_all(b"partial replacement")?;
            Err(io::Error::other("simulated crash before rename"))
        });

        assert!(error.is_err());
        assert_eq!(fs::read(&path).unwrap(), b"original document");
        assert!(!dir.join("library.json.tmp").exists());
        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn a_successful_rewrite_replaces_the_previous_document() {
        let dir = temp_dir("replace");
        let path = dir.join("library.json");
        fs::write(&path, b"old").unwrap();

        atomic_write(&path, b"new").unwrap();

        assert_eq!(fs::read(&path).unwrap(), b"new");
        assert!(!dir.join("library.json.tmp").exists());
        fs::remove_dir_all(&dir).ok();
    }
}