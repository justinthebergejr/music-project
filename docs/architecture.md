# Architecture

## The load-bearing decision

Every audio byte is served by a loopback HTTP server in Rust (`127.0.0.1`, ephemeral
port, session token), for local files and resolved YouTube tracks alike.

Why, concretely:

1. **Web Audio needs CORS.** `createMediaElementSource()` on a cross-origin element
   without CORS yields silence in the analyser, with no error, and cannot be undone for
   that element. `googlevideo.com` does not send `Access-Control-Allow-Origin`.
2. **`asset://` is not a media transport.** Tauri's asset protocol re-reads from byte 0
   on every Range request (tauri#6375), so seeking a large file is linear. It works in
   `tauri dev` and degrades in a bundle — a late-project failure mode.
3. WebKit treats `asset://`/`tauri://`/`blob:` and `http://` as different media
   pipelines. `http://127.0.0.1` is the fast, seekable one on both platforms.

Consequence: **cache-then-play.** `resolve_track` lets yt-dlp download into the app
cache, then the webview plays a local URL. This gives native seeking, immune-to-expiry
playback, a working analyser, and a free offline demo backup. Cost: a 1–2 s buffer on
first play of a track.

## Layers

```
┌──────────────────────────── WebView (React) ─────────────────────────────┐
│  views/        presentational, no audio, no invoke()                     │
│  features/     React hooks binding core modules to components            │
│  core/         plain TypeScript — no React import, no @tauri-apps import  │
│    audio/ player/ visualizer/ lyrics/ library/ streaming/ theme/ platform/│
│  core/platform is the only place that calls invoke()                     │
└───────────────┬──────────────────────────────────▲───────────────────────┘
                │ invoke()                         │ GET http://127.0.0.1:PORT/m/<token>/<id>
┌───────────────▼──────────────────────────────────┴───────────────────────┐
│  Rust                                                                    │
│    commands.rs     argument marshalling only                             │
│    media_server.rs ★ Range, token, opaque ids, CORS                      │
│    sidecar.rs      ★ argv-only yt-dlp invocation, URL allowlist          │
│    library_fs.rs   temp → fsync → rename atomic JSON writes              │
│    media_cache.rs  managed-cache LRU walk, .part/keepPaths protection    │
└──────────────────────────────────────────────────────────────────────────┘
```

★ = security boundary. Reviewed line by line, with hand-written tests.

## Audio graph

```
<audio crossOrigin="anonymous">
  → MediaElementAudioSourceNode
  → BiquadFilter ×10 (peaking, 32 Hz … 16 kHz)
  → GainNode
  → AnalyserNode → destination
        └→ Uint8Array read by CanvasVisualizer's rAF loop
```

Invariants:

- exactly one `AudioContext` for the process (module singleton)
- exactly one `MediaElementSourceNode` per audio element; never rebuilt on track change
- nothing in React creates audio nodes or reads the analyser per frame
- `AudioContext.resume()` happens inside a real user gesture

## Player, library and cache

```
App (React)
  │ useSyncExternalStore(controller.subscribe, controller.getSnapshot)
  ▼
PlayerController ──owns──> one detached <audio crossOrigin="anonymous">
  │                              │
  │                              └── engine.attach() exactly once in the constructor
  ├── queue / repeat / shuffle / sequence token
  ├── duration policy: metadata wins when > 0; element value logged on >5% mismatch
  └── resolveSource(track) ──> core/platform/media ──invoke──> Rust
                                      │
                                      ├── resolve_track → cache path + loopback URL
                                      └── register_local_file → loopback URL
```

React never creates an audio element and never calls `createMediaElementSource`. The
controller is a process singleton, like the audio graph; React StrictMode cannot create a
second one.

**Library.** `core/library` is plain TypeScript. `repo.ts` loads/saves a versioned JSON
document; `core/platform/libraryStorage.ts` owns the path (`appDataDir()` + `library.json`)
and the `invoke()` calls. Rust `library_fs::atomic_write` performs temp file → fsync →
rename, and `validate_library_path` refuses anything that is not `library.json` directly
inside app data. An unknown version or bad JSON is copied to `library.json.bak` before
defaults are returned.

**Managed cache.** `resolve_track` downloads into `<app cache>/media`. `cache_stats` and
`cache_evict` walk only regular files directly in that directory, skip `*.part`/`*.ytdl`,
sort by mtime, and never delete a `keepPaths` entry. The currently playing file is passed
through `keepPathsForTrack()`; evicted files are removed from `MediaServer`'s id map so a
stale URL 404s.

## Boundaries worth keeping honest

| Boundary | Rule | Enforced by |
|---|---|---|
| React ↔ audio | `core/**` never imports React; the controller owns the only `<audio>` | ESLint `no-restricted-imports` + `features/player/usePlayer` |
| Frontend ↔ native | only `core/platform` imports `@tauri-apps/*`; only it calls `invoke()` | ESLint `no-restricted-imports` (the one documented exception) |
| Frontend ↔ disk | no arbitrary path reads; media ids only, resolved from an in-memory map | `media_server.rs` |
| Library ↔ disk | atomic temp + fsync + rename; only `library.json` in app data | `library_fs.rs` tests |
| Cache ↔ disk | app cache directory only; `.part`/`.ytdl` and `keepPaths` never deleted; evicted ids forgotten | `media_cache.rs` tests + `MediaServer::forget_paths` |
| Rust ↔ shell | never a shell; argv arrays; `--` before positionals | `sidecar.rs` + tests |

## Deliberate non-goals for v1

Accounts and sync, recommendations, plugins, pitch shifting, bundled ffmpeg, Intel
macOS, WebGL shaders, OS media keys, output-device switching.
