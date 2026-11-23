# Malice

A desktop music player for Windows and macOS: local files plus streamed audio resolved
from YouTube Music, a 10-band EQ, real-time visualizers, album-art theming, and
synced lyrics.

Built for a cybersecurity course project with heavy LLM assistance. The graded parts are
the working demo, the write-up, and the evidence that LLM output was reviewed, tested,
and hardened — not just accepted.

## Status

Day 2 of 14: player and library foundations.

- [x] Day 1 infrastructure: Tauri 2 shell, loopback media server with Range support,
      single Web Audio graph, checksum-verified `yt-dlp` bootstrap
- [x] Library domain model and versioned JSON store, with fsync + rename atomic writes
      and `library.json.bak` on an unknown version
- [x] `PlayerController`: owns the one `<audio>` element, queue/repeat/shuffle,
      sequence-token concurrency, and the metadata-duration policy moved out of React
- [x] React renders playback from `useSyncExternalStore`; `App.tsx` contains no audio
      element and no playback logic
- [x] Managed media cache: `cache_stats` / `cache_evict`, LRU by mtime, 500 MB default,
      current track protected, `.part` downloads untouched, evicted ids 404
- [x] ESLint flat config: `core/**` cannot import React, and only `core/platform`
      may import `@tauri-apps/*`
- [x] 25 Vitest tests + 22 Rust tests (1 network test ignored)
- [ ] Verified on Windows (pending)
- [ ] Everything else

Day 1 acceptance is unchanged: a resolved track plays through the loopback server, a
3:11 track reads 3:11, the analyser peak is non-zero, and exactly one `AudioContext`
exists. See `docs/day1-smoke-test.md`.

## Run it

```bash
npm install
npm run tauri dev          # development
npm run tauri build        # bundled app in src-tauri/target/release/bundle
npm run build              # typecheck + frontend bundle
npm run lint               # core import boundaries
npm test                   # Vitest: library, ids, controller, cache-path glue
cargo test --manifest-path src-tauri/Cargo.toml
```

`yt-dlp` is installed and updated by the app itself on first launch (checksum-verified,
no manual setup). A system `yt-dlp` is only a last-resort fallback if that fails.

### Day 1 acceptance

Open the app, load a local file, confirm the analyser peak is above zero, drag an EQ
band and hear it, then paste a YouTube URL and press Resolve. The checklist panel on
the right tracks each of those. Details and failure responses: `docs/day1-smoke-test.md`.

## Day 2 verification notes

Automated checks, run in this checkout on 2026-11-23:

```text
npm run build                         pass
npx eslint src --max-warnings=0       pass
npm test                              25 passed (4 files)
cargo test --manifest-path src-tauri/Cargo.toml
                                      22 passed, 1 ignored (network install test)
```

Manual checks are **not** claimed here. This checkout was verified in a headless agent
environment with no GUI or audio device. The three checks that need a real webview are
recorded as K/L/M in `docs/day1-smoke-test.md`:

- a 3:11 track still reads 3:11;
- the analyser peak is non-zero while playing;
- switching tracks does not create a second `AudioContext`.

Run `npm run tauri dev` on the target Mac, follow those steps, and tick the boxes before
calling Day 2 complete. The code-level evidence is the process singleton in
`src/core/player/index.ts`, the single `refreshDuration()` in `PlayerController`, and the
25 Vitest tests that exercise the duration, concurrency, and repeat paths.

No changes were made to `tauri.conf.json`, `capabilities/`, the media-server route/token
contract, or the `yt-dlp` bootstrap.

## Honest limits

- Streaming relies on `yt-dlp` against YouTube. That is a Terms-of-Service gray area,
  the extractor breaks when YouTube changes, and nothing here is distributed or
  redistributed. Local playback is the primary supported path.
- Playing a resolved stream loads no YouTube player, so no ads are served. This is a
  consequence of the architecture, not an ad-blocking feature.
- Lyrics are fetched from third-party providers and cached locally for display. No lyric
  text is redistributed.
- No account, no telemetry. YouTube and any lyrics provider still see your IP address.

## License

MIT. See `LICENSE` and `THIRD_PARTY.md` for dependency licenses.
