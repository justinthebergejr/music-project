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
│    audio/ visualizer/ lyrics/ library/ streaming/ theme/ platform/       │
│  core/platform is the only place that calls invoke()                     │
└───────────────┬──────────────────────────────────▲───────────────────────┘
                │ invoke()                         │ GET http://127.0.0.1:PORT/m/<token>/<id>
┌───────────────▼──────────────────────────────────┴───────────────────────┐
│  Rust                                                                    │
│    commands.rs     argument marshalling only                             │
│    media_server.rs ★ Range, token, opaque ids, CORS                      │
│    sidecar.rs      ★ argv-only yt-dlp invocation, URL allowlist          │
│    library_fs.rs   import, canonicalize, extension allowlist             │
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

## Boundaries worth keeping honest

| Boundary | Rule | Enforced by |
|---|---|---|
| React ↔ audio | `core/**` never imports React | ESLint `no-restricted-imports` (TODO Day 3) |
| Frontend ↔ native | only `core/platform` calls `invoke()` | same lint rule |
| Frontend ↔ disk | no arbitrary path reads; ids only, resolved from an in-memory map | `media_server.rs` |
| Rust ↔ shell | never a shell; argv arrays; `--` before positionals | `sidecar.rs` + tests |

## Deliberate non-goals for v1

Accounts and sync, recommendations, plugins, pitch shifting, bundled ffmpeg, Intel
macOS, WebGL shaders, OS media keys, output-device switching.
