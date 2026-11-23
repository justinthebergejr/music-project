# Spec: managed media cache

**Files:** `src-tauri/src/media_cache.rs`, `src-tauri/src/lib.rs`,
`src-tauri/src/media_server.rs`, `src/core/platform/cache.ts`
**Status:** implemented (Day 2)

## Purpose

Bound the size of the YouTube media cache without ever deleting a file that is being
played, a partial download, or anything outside the app's own cache directory. Evicted
paths must also disappear from the media server's id → path map so an old URL returns
404 instead of serving a ghost.

## Commands

```text
cache_stats(capBytes: u64) -> { bytes, files, capBytes }
cache_evict(capBytes: u64, keepPaths: string[]) -> { bytes, files, capBytes }
```

`capBytes` is passed from the frontend. `src/core/platform/cache.ts` owns the default
`DEFAULT_CACHE_CAP_BYTES = 500 * 1024 * 1024` so the policy is visible in one place and
the Rust side has no hidden global limit. Both commands run the filesystem walk on a
blocking thread (`spawn_blocking`) rather than on the webview's IPC thread.

## What counts as a managed file

A managed file is:

- a **regular file** directly inside the media cache directory
  (`<app cache>/media`, created at startup),
- whose extension is not `.part` (an in-progress yt-dlp download) and not `.ytdl`
  (yt-dlp's in-progress metadata sidecar).

Directories, symlinks, and anything outside that directory are never considered. The
cache directory is app-owned and exists only for downloaded media, so a regular audio
file directly in it is treated as managed. This is the boring interpretation of "ignore
files it did not create": do not follow links, do not recurse, and do not accept a path
from the caller.

## Eviction

1. Collect managed entries with size and mtime.
2. Sort by mtime ascending, then path (deterministic tie-break).
3. While total size > `capBytes`, delete the oldest entry unless its canonical path is in
   `keepPaths` or the delete fails.
4. Return the post-eviction `{ bytes, files, capBytes }`.

Consequences:

- Protected paths can keep the cache above the cap. That is preferred to deleting the
  file that is currently playing.
- `keepPaths` may contain local library files outside the cache; they simply never match
  a managed entry.
- A deleted file is reported to the caller so `MediaServer::forget_paths` can remove its
  id. A stale URL then 404s.
- The frontend calls `cache_evict` after a track starts playing, passing
  `keepPathsForTrack(snapshot.track)`. For YouTube that includes the resolved cache path
  returned by `resolve_track`; for local files it includes the library path. Eviction is
  skipped for a track id already processed in this session, so resuming does not rerun
  the walk.

## MediaServer change

Add `forget_paths(&[PathBuf])`: remove every map entry whose stored path is in the list.
`cache_evict` calls it with the paths it actually deleted. No route, token, or id format
changes; this is additive to the existing media-server contract.

## Ambiguities and chosen boring options

1. **`cache_stats` signature** — the task lists it with no arguments but asks for a
   `capBytes` field. It takes `capBytes` and echoes it, so the caller sees the cap it asked
   about.
2. **"only files it did not create"** — the cache directory is exclusively for media the
   app downloaded. Persisting a separate provenance list would add a second source of
   truth; restricting to regular direct children is sufficient and easy to audit.
3. **LRU** — mtime is the age key. Serving a Range request does not touch mtime, so a
   recently played file can still be old; the currently playing file is protected
   explicitly through `keepPaths`. A later version can touch files on serve if needed.
4. **Protected files over cap** — the cap is a target, not an invariant that justifies
   deleting a file in use.

## Test list

- [x] eviction removes the oldest files until the total is at or under the cap
- [x] protected paths survive eviction even when the cap is still exceeded
- [x] `*.part` (and `.ytdl`) files are never counted or deleted
- [x] only regular files directly inside the cache directory are touched
- [x] an evicted path is forgotten by `MediaServer`, so its URL 404s
- [x] stats report bytes/files/cap after eviction

## Out of scope

Cross-device cache, user-facing cache UI, pinning tracks forever, and eviction during a
download (partial files are skipped, not cancelled).