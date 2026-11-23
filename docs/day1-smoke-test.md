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
| J | First launch installs a verified `yt-dlp` with no manual setup | delete the app-data `bin/` dir, relaunch, watch the progress bar | ✅ headless | ☐ |

`cargo test` covers what can be tested headlessly: Range parsing and clamping, the
token check, path-traversal rejection, URL validation (including flag-shaped input),
checksum mismatch rejection, and — with `--ignored` — a real download that must verify
and run.

```bash
cargo test --manifest-path src-tauri/Cargo.toml
cargo test --manifest-path src-tauri/Cargo.toml -- --ignored --nocapture  # network
```

## Day 2 manual checks — player, library, cache

The automated parts of Day 2 are `npm test` (25 tests), `npm run lint`,
`npm run build`, and `cargo test` (22 tests + 1 ignored network test). These three
checks still need a real webview and audio device. They are recorded here so they are
not lost, and the result boxes are deliberately unclaimed by the headless agent
environment that produced this commit.

| # | Check | Steps | Expected | Result |
|---|-------|-------|----------|--------|
| K | A 3:11 track still reads 3:11 | Resolve a track whose metadata duration is ~191.4 s and play it. Compare the transport display with `afinfo`/`ffprobe`. | Transport reads `3:11` for the whole track. If WebKit reports 382.8 s, the console shows `[player] duration mismatch: element 382.8s vs metadata 191.4s — using metadata` and the UI does **not** double. | ☐ not run (no GUI/audio in the agent environment) |
| L | Analyser peak is non-zero while playing | Play any resolved or local track; watch the analyser meter and the checklist. | Peak rises above `0.005`; the checklist turns green; bars move. A flat `0.000` means a CORS/taint regression. | ☐ not run |
| M | Track switching does not create a second `AudioContext` | Open the web inspector. Set a breakpoint in the `AudioEngine` constructor (or use the Web Audio panel on WebView2). Switch tracks three times. | The constructor is hit once for the process. One `AudioContext`; one `MediaElementSourceNode`; no second `<audio>` element created by React. | ☐ not run |

The implementation evidence for these checks:

- `PlayerController` is a process singleton (`core/player/index.ts`), and its constructor
  is the only place that calls `new Audio()` and `engine.attach()`.
- The duration policy is a single `refreshDuration()` in `PlayerController`, covered by
  `PlayerController.test.ts` with an element duration exactly 2× metadata.
- `App.tsx` contains no `<audio>` and no `play()`, `pause()`, `currentTime`, or
  `createMediaElementSource` call; it renders from
  `useSyncExternalStore(controller.subscribe, controller.getSnapshot)`.

## Failure → response

| Symptom | Most likely cause | Response |
|---|---|---|
| Analyser peak stays `0.000` | missing `Access-Control-Allow-Origin`, or media loaded cross-origin without `crossOrigin="anonymous"` | confirm headers with `curl -I`; the media must come from 127.0.0.1 |
| Audio silent after connecting the graph | element was already tainted; `createMediaElementSource` cannot be undone | reload the track; if it persists, switch to the `decodeAudioData` substrate |
| Seek takes seconds | bytes are being streamed from byte 0 instead of `seek()`ed | check `Content-Range` and that the handler seeks the file handle |
| Window is blank with CSP violations | `devCsp`/`csp` missing an origin | fix the policy, never disable it |
| `yt-dlp` exits non-zero | extractor drift, region lock, or age gate | try another track; update the sidecar; this is why the demo is pre-cached |
| Visualizer janks on macOS only | `backdrop-filter` over a live canvas | blur a static layer, drop radius, or lower canvas DPR |

## Toolchain bootstrap

The app installs and updates its own `yt-dlp`, because a bundled app launched from
Finder does not inherit a shell `PATH` and a fresh machine has no binary at all.

Policy, in order:

1. **Managed copy** in `<app data>/bin/yt-dlp` — checksum-verified, used and updated.
2. **Bundled sidecar** next to the executable (for future packaged builds).
3. **System binary** — last resort only, after a failed bootstrap.

A system binary is never preferred in step 1, even in development: anything found on
`PATH` is an unverified executable, and PATH is a code-execution vector.

Rules that are not optional:

- the release asset is hashed *while* streaming to `*.part`, compared against the
  SHA-256 published by the release, and only then renamed into place
- a candidate must answer `--version` before it replaces a working binary
- the previous binary stays as `yt-dlp.bak`, so a bad update is one rename to undo
- update checks are throttled to every 6 hours; a failed update never breaks a working install

Verified: `cargo test -- --ignored` installs `yt-dlp 2026.10.26` into a temp directory,
probes it, and cleans up. A separate test proves a mismatched checksum deletes the
download instead of installing it.

## Audio substrate contract

`AudioEngine` owns exactly one `AudioContext` and one `MediaElementAudioSourceNode`.
Both the local path and the YouTube path feed the same element, so there is exactly one
graph. Nothing in React may create an `AudioContext`, and the visualizer may not be
driven by React state.

Decision gate: if the analyser reads zero on either platform after ~3 hours of
debugging, switch that platform to `decodeAudioData` → `AudioBufferSourceNode` → EQ →
analyser. Cache-then-play means the whole file is already on disk, so the alternative
costs nothing but native streaming.
