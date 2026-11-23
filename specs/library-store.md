# Spec: library store

**Files:** `src/core/library/{types,ids,normalize,repo}.ts`,
`src/core/platform/libraryStorage.ts`, `src-tauri/src/library_fs.rs`, `src-tauri/src/lib.rs`
**Status:** implemented (Day 2)

## Purpose

Keep the user's tracks, playlists and settings in one versioned JSON document, and make
crash-safe writes a property of the storage layer rather than a convention in the UI.

`core/library` is plain TypeScript. It never imports `@tauri-apps/*`; filesystem access is
the `LibraryIO` seam implemented by `core/platform/libraryStorage.ts`.

## Data model

```ts
type TrackSource = 'youtube' | 'local';

interface Track {
  id: string;            // 'yt:<videoId>' | 'local:<sha256 of canonical path>'
  title: string;
  artist: string | null;
  album: string | null;
  durationSec: number;   // authority for UI duration; 0 if unknown
  source: TrackSource;
  artUrl: string | null;
  filePath: string | null; // local only
  addedAt: number;         // epoch ms
}

interface Settings { volume: number; eqGains: number[] /* exactly 10 */ }
interface Playlist { id: string; name: string; trackIds: string[] }
interface Library { version: 1; tracks: Track[]; playlists: Playlist[]; settings: Settings }
```

Defaults: `volume = 1`, ten `eqGains` at `0` dB. Settings are clamped on read
(`volume` 0..1, each gain -12..12) and `eqGains` is always padded/truncated to ten.

## Deterministic ids

- YouTube: `yt:` + the video id reported by the resolver. No random ids.
- Local: `local:` + lowercase hex SHA-256 of the canonicalized path bytes. The canonical
  path comes from Rust (`canonicalize_local_file`), never from a shell or a guess.
- `yt:abc` and `local:<sha>abc` can never collide because of the prefix.

The local id is async because it uses `crypto.subtle.digest('SHA-256', …)`. Tauri's
webview is a secure context, as is Node's test environment. The path is hashed verbatim:
callers must pass the canonical path.

## Persistence

- Location: `<app data>/library.json`. The path is produced by
  `core/platform/libraryStorage.ts` via Tauri's `appDataDir()` and passed to Rust, which
  rejects any path that is not `library.json` **directly inside** the app data directory.
- `library_read` returns `null` when the file does not exist.
- `library_write` performs an atomic write:
  1. write `<file>.tmp` with create/truncate,
  2. `flush`/`sync_all` (fsync),
  3. `rename(<file>.tmp, <file>)` over the target,
  4. fsync the parent directory on Unix (best effort).
  A crash before the rename leaves the old target intact; a crash after it leaves the new
  target intact. A partial file is never the target.
- `library_backup` copies the current file to `library.json.bak` (overwriting an older
  backup). The original is **not** renamed or deleted.

## Versioning

`version: 1` is the only supported version.

- Unknown `version` (including a missing/non-numeric version) → return a default library
  and write `library.json.bak` first. The unknown file is left untouched.
- Invalid JSON → same fallback and backup.
- A read failure that is not a parse/version problem → return defaults without claiming a
  backup was made.

Migration is a future change: add a `migrate(unknown) -> Library` step before
`normalize` when version 2 exists. The `.bak` is the rollback path.

## Ambiguities and chosen boring options

1. **"All filesystem access goes through the Rust side or a platform module"** — both are
   used. `core/platform/libraryStorage.ts` owns the path and the `invoke()` calls; the
   fsync/rename primitive lives in Rust because JavaScript cannot fsync.
2. **"Path from core/platform"** — the JS module computes the path with `appDataDir()` and
   `join()`, then Rust validates it. This keeps the path out of `core/library` without
   handing Rust an unconstrained path.
3. **"Unknown version => keep a .bak"** — the source file is copied, not moved. If the app
   later writes defaults, the `.bak` still holds the unknown document.
4. **Normalization of malformed tracks** — records missing a valid id/source are dropped;
   playlists keep only ids that exist after normalization. This keeps the in-memory model
   consistent with what the player can actually play.
5. **An `LibraryIO` read error is not a version problem** — defaults are returned but no
   `.bak` is invented for a file that may not exist.

## Public API

```ts
// ids.ts
function youtubeTrackId(videoId: string): string;
function localTrackId(canonicalPath: string): Promise<string>;

// repo.ts
function loadLibrary(io?: LibraryIO): Promise<Library>;
function saveLibrary(library: Library, io?: LibraryIO): Promise<void>;
function upsertTrack(library: Library, track: Track): Library;
function removeTrack(library: Library, trackId: string): Library;
function upsertPlaylist(library: Library, playlist: Playlist): Library;
function setSettings(library: Library, settings: Settings): Library;
```

## Test list

- [x] round-trip: save then load preserves tracks, playlists and settings
- [x] atomic write: a failed write leaves the old target intact and removes `.tmp`
      (`library_fs::tests`, Rust)
- [x] unknown version returns defaults and leaves a `.bak`
- [x] invalid JSON takes the same fallback
- [x] ids are stable for the same input and differ across sources

## Out of scope

SQLite, syncing, multi-user libraries, play counts, and any state-management library.