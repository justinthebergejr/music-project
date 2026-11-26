# Malice

A desktop music player for macOS, with a Windows build wired into CI: local files plus
streamed audio resolved from YouTube Music, a 10-band EQ, a real-time visualizer, and —
in progress — album-art theming and synced lyrics.

Built for a cybersecurity course project with heavy LLM assistance. The graded parts are the
working demo, the write-up, and the evidence that LLM output was specified, reviewed,
tested, and hardened rather than accepted. That evidence lives in
[`docs/llm-log.md`](docs/llm-log.md).

> **Status: Day 2 of 14.** The playback and data spine is complete and verified at the code
> level. macOS is the demo target; Windows builds in CI but has not been run by hand. The UI
> in this repository is still a diagnostic harness — the product shell comes next.

## Status

- [x] **Day 1 — infrastructure.** Tauri 2 shell, loopback HTTP media server with `Range`
      support and a per-launch token, one Web Audio graph (10× biquad → analyser), canvas
      visualizer on its own `requestAnimationFrame` loop, and a checksum-verified `yt-dlp`
      bootstrap with rollback.
- [x] **Library.** Track model with deterministic ids (`yt:<videoId>`, `local:<sha256>`),
      versioned JSON store with fsync + rename atomic writes, `.bak` on unknown version.
- [x] **PlayerController.** Owns the single `<audio>` element, queue / shuffle / repeat,
      sequence-token concurrency, typed errors, and the metadata-duration policy moved out
      of React.
- [x] **React binding.** App renders playback from `useSyncExternalStore`; no audio element
      and no playback logic in components.
- [x] **Managed media cache.** `cache_stats` / `cache_evict`, LRU by mtime, 500 MB default,
      currently playing file protected, `.part` downloads untouched, evicted ids 404.
- [x] **Import boundaries.** ESLint flat config: `core/**` cannot import React, and only
      `core/platform` may import `@tauri-apps/*`.
- [x] **Tests.** 25 Vitest + 22 Rust (1 network test ignored).
- [ ] Search (URL paste only today)
- [ ] Product UI: nav rail, playlist view, player bar, album-art theming
- [ ] Lyrics: LRCLIB line-sync, word-level TTML
- [ ] Verified on Windows by hand

Day 1 acceptance still holds: a resolved track plays through the loopback server, a 3:11
track reads 3:11, the analyser peak is non-zero, and exactly one `AudioContext` exists.
See [`docs/day1-smoke-test.md`](docs/day1-smoke-test.md).

## Requirements

- macOS on Apple Silicon (the only supported macOS target; Intel is out of scope)
- Node 20+ and Rust stable (`rustup`)
- Xcode Command Line Tools (`xcode-select --install`)

`yt-dlp` is **not** a prerequisite — the app installs and maintains its own verified copy.

## Quick start

```bash
npm install
npm run tauri dev            # development window with HMR

npm run tauri build          # bundle in src-tauri/target/release/bundle
npm run build                # typecheck + frontend bundle
npm run lint                 # core import boundaries
npm test                     # Vitest: library, ids, controller, cache glue
cargo test --manifest-path src-tauri/Cargo.toml
```

## Verify it works

Open the app and work down the checklist panel:

1. **Audio graph** turns green immediately (one context, 10 bands, device sample rate).
2. **yt-dlp** installs on first launch (a few seconds, ~35 MB) and reports its version.
3. **Open local file…** → choose audio → *analyser peak* must rise above `0.000`.
   Zero means the media is cross-origin-tainted and the visualizer is dead.
4. Paste `https://www.youtube.com/watch?v=dQw4w9WgXcQ` → **Resolve** → playback starts.
5. **Seek → 80%** → expect well under 500 ms.

Day 2 adds three checks that need a real webview (K/L/M in `docs/day1-smoke-test.md`):

- a 3:11 track still reads 3:11;
- the analyser peak is non-zero while playing;
- switching tracks does not create a second `AudioContext`.

### Day 2 verification notes

```text
npm run build                         pass
npx eslint src --max-warnings=0       pass
npm test                              25 passed (4 files)
cargo test                           22 passed, 1 ignored (network install test)
```

Manual checks are **not** claimed here. This checkout was verified in a headless agent
environment with no GUI or audio device, so K/L/M above are unticked on purpose. Run
`npm run tauri dev` on the target Mac before calling Day 2 complete.

## How it works

```
webview (React)
  └─ core/library        Track model, deterministic ids, atomic JSON store
  └─ core/player         PlayerController: one <audio>, queue, duration policy
  └─ core/audio          AudioEngine: one AudioContext, one MediaElementSource,
                         10× biquad → gain → analyser → destination
  └─ core/visualizer     CanvasVisualizer: rAF loop, reads analyser, never React state
  └─ core/platform       the only module allowed to call invoke()
Rust
  └─ media_server.rs     loopback HTTP, Range, session token, opaque ids
  └─ sidecar.rs          argv-only yt-dlp, host allowlist, cache containment
  └─ bootstrap.rs        verified toolchain install/update with rollback
  └─ lib.rs              thin #[tauri::command] wrappers
```

Four decisions explain most of the design.

**Every audio byte comes through a loopback HTTP server.** `createMediaElementSource()`
returns silence for cross-origin media without CORS, and Tauri's `asset://` protocol
re-reads from byte 0 on every range request. Serving from `127.0.0.1` fixes both and gives
one place to enforce tokens, path allowlisting, and range handling.

**Cache-then-play, not stream-through.** yt-dlp downloads to disk first; the player then
uses a complete file. Seeking becomes native, signed-URL expiry stops mattering, the
analyser stays fed, and an offline demo fallback comes free. The cost is a one- to two-second
buffer on first play.

**Duration metadata beats the media element.** YouTube's DASH audio arrives as a fragmented
MP4, which WebKit's incremental parser misreports — exactly 2× on the first track tested.
Cached media loads as a `Blob` to avoid that code path, and the resolver's duration wins
whenever the two disagree by more than 5%.

**One audio graph, one owner.** The `PlayerController` creates the element and attaches it
to the engine once; React only renders snapshots. Nothing in a component can create an
`AudioContext`, and track changes never rebuild the graph.

More: [`docs/architecture.md`](docs/architecture.md) ·
[`specs/`](specs/).

## Security

The app downloads and executes a third-party binary, parses attacker-controlled text, and
opens a local port. Those are the threat model, not footnotes.

- `yt-dlp` downloads stream to `*.part`, are hashed, compared against the SHA-256 published
  in the release, `--version`-probed, and only then promoted. The previous binary stays as
  `yt-dlp.bak`.
- A binary found on `PATH` is never preferred, even in development: an unverified executable
  reached through `PATH` is code execution.
- The sidecar is spawned with an argv array — never a shell — with `--` before positionals,
  a host allowlist, and rejection of whitespace/control characters in URLs.
- The media server binds `127.0.0.1` on an ephemeral port, requires a per-launch token,
  serves only opaque ids from an in-memory map, and sends `Cache-Control: no-store`.
- No account, no cookies, no telemetry. No credentials exist to steal.

Checklist and current status: [`docs/security-tests.md`](docs/security-tests.md).
Threat model: [`docs/threat-model.md`](docs/threat-model.md).

## Honest limits

- **Streaming relies on yt-dlp against YouTube, which is a Terms-of-Service gray area.**
  Nothing is distributed and no media is redistributed. The extractor breaks when YouTube
  changes; local playback is the primary supported path. Treat this as a research prototype.
- **"Ad-free" is a consequence, not a feature.** Playing a resolved stream loads no YouTube
  player, so no ad is served. It is not ad-blocking, and there is no fallback that preserves
  that property if extraction fails.
- **No account is not the same as no tracking.** YouTube and any lyrics provider still see
  your IP address.
- **Cached audio and lyrics are copyrighted.** They stay on your machine, are evicted
  eventually, and are never uploaded.
- **Unsigned builds.** macOS warns on first open. The project does not recommend stripping
  quarantine flags; build from source instead.
- **Windows is unverified by hand.** Asset naming, the download path, and installer
  bundling have never run on a real Windows machine.

## Project layout

```
src/
  core/library/        Track model, ids, atomic JSON store
  core/player/         PlayerController (plain TS, no React)
  core/audio/          AudioEngine — the only code allowed to create audio nodes
  core/visualizer/     CanvasVisualizer — rAF, DPR-aware, disposable
  core/platform/       the only place that calls invoke()
  App.tsx              diagnostic harness (being replaced by the real shell)
src-tauri/src/
  lib.rs               thin #[tauri::command] wrappers
  media_server.rs      Range, token, opaque ids          (security boundary)
  sidecar.rs           yt-dlp invocation, URL allowlist  (security boundary)
  bootstrap.rs         verified toolchain install
docs/                  architecture, threat model, security tests, LLM bug log
specs/                 one spec per module, written before the code
```

## Roadmap

| Phase | Work |
|---|---|
| Day 3 | Product shell: top bar, nav rail, playlist view, player bar, album-art theming |
| Days 4–5 | Search, robustness, first-run polish, Windows sanity pass |
| Days 6–9 | Now Playing panel, lyrics pipeline (LRCLIB line-sync, word-level TTML) |
| Days 10–11 | Security pass: lyric-rendering XSS, parser DoS caps, rate limiting, dependency audit |
| Days 12–14 | Demo hardening, offline rehearsal, write-up, buffer |

## License

MIT — see [`LICENSE`](LICENSE).

Third-party terms: `yt-dlp` is Unlicense; Tauri, React, and Vite are MIT/Apache-2.0.
**ffmpeg is deliberately not bundled** — if it ever is, it must be an LGPL build shipped as
a separate executable with a source offer.

## Working with an LLM

Every module was written against a spec in [`specs/`](specs/) before code, one module per
prompt, with tests required alongside. Defects that the model introduced — or that I
introduced while fixing its output — are recorded with how they were found and the
regression test that now prevents them, in [`docs/llm-log.md`](docs/llm-log.md).
