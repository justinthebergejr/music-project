# Day 1 smoke test — results

Purpose: prove the four things that can kill the project **before** any feature work,
and prove them from a **built bundle**, not `tauri dev`. In dev, the frontend is served
over HTTP; in a bundle it is not. Several media bugs only exist in the second case.

## What the app in this commit proves

| # | Check | How it is proved | macOS (arm64) | Windows (x64) |
|---|-------|------------------|---------------|---------------|
| A | Tauri 2 bundle builds and launches | `npm run tauri build` → `target/release/bundle` | ☐ | ☐ |
| B | Local file plays through the loopback server | "Open local file…" → analyer peak > 0 | ☐ | ☐ |
| C | MediaElementSource is **not** tainted | `analyser peak` check turns green | ☐ | ☐ |
| D | 10-band EQ is in the graph | drag a band, hear the change | ☐ | ☐ |
| E | Canvas visualizer runs off the analyser | bars move; FPS acceptable with blur on | ☐ | ☐ |
| F | yt-dlp resolves and caches a track | "Resolve" → checklist `yt-dlp resolves` | ☐ | ☐ |
| G | YouTube playback uses the same graph | `YouTube playback` turns green | ☐ | ☐ |
| H | Range/seek is not doing a linear re-read | "Seek → 80%" under 500 ms | ☐ | ☐ |
| I | CSP allows the app and blocks everything else | window renders, no CSP errors in console | ☐ | ☐ |

`cargo test` covers what can be tested headlessly: Range parsing and clamping, the
token check, path-traversal rejection, and URL validation (including flag-shaped input).

## Failure → response

| Symptom | Most likely cause | Response |
|---|---|---|
| Analyser peak stays `0.000` | missing `Access-Control-Allow-Origin`, or media loaded cross-origin without `crossOrigin="anonymous"` | confirm headers with `curl -I`; the media must come from 127.0.0.1 |
| Audio silent after connecting the graph | element was already tainted; `createMediaElementSource` cannot be undone | reload the track; if it persists, switch to the `decodeAudioData` substrate |
| Seek takes seconds | bytes are being streamed from byte 0 instead of `seek()`ed | check `Content-Range` and that the handler seeks the file handle |
| Window is blank with CSP violations | `devCsp`/`csp` missing an origin | fix the policy, never disable it |
| `yt-dlp` exits non-zero | extractor drift, region lock, or age gate | try another track; update the sidecar; this is why the demo is pre-cached |
| Visualizer janks on macOS only | `backdrop-filter` over a live canvas | blur a static layer, drop radius, or lower canvas DPR |

## Audio substrate contract

`AudioEngine` owns exactly one `AudioContext` and one `MediaElementAudioSourceNode`.
Both the local path and the YouTube path feed the same element, so there is exactly one
graph. Nothing in React may create an `AudioContext`, and the visualizer may not be
driven by React state.

Decision gate: if the analyser reads zero on either platform after ~3 hours of
debugging, switch that platform to `decodeAudioData` → `AudioBufferSourceNode` → EQ →
analyser. Cache-then-play means the whole file is already on disk, so the alternative
costs nothing but native streaming.
