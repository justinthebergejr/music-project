# Malice

A desktop music player for Windows and macOS: local files plus streamed audio resolved
from YouTube Music, a 10-band EQ, real-time visualizers, album-art theming, and
synced lyrics.

Built for a cybersecurity course project with heavy LLM assistance. The graded parts are
the working demo, the write-up, and the evidence that LLM output was reviewed, tested,
and hardened — not just accepted.

## Status

Day 1 of 14: infrastructure spike only.

- [x] Tauri 2 shell (React + Vite + TypeScript), builds a macOS arm64 bundle
- [x] Loopback HTTP media server with Range support, session token, opaque ids
- [x] Single Web Audio graph: element → 10× biquad EQ → gain → analyser → output
- [x] Canvas visualizer driven by `requestAnimationFrame`, outside React
- [x] yt-dlp resolve → download to cache → play from loopback
- [x] Unit tests for Range parsing, token checks, path traversal, URL validation
- [ ] Verified on Windows (pending)
- [ ] Everything else

## Run it

```bash
npm install
npm run tauri dev          # development
npm run tauri build        # bundled app in src-tauri/target/release/bundle
cargo test --manifest-path src-tauri/Cargo.toml
```

`yt-dlp` must be on `PATH` during development. Sidecar bundling for release builds is not
wired up yet, so release artifacts also expect `yt-dlp` on `PATH` for now.

### Day 1 acceptance

Open the app, load a local file, confirm the analyser peak is above zero, drag an EQ
band and hear it, then paste a YouTube URL and press Resolve. The checklist panel on
the right tracks each of those. Details and failure responses: `docs/day1-smoke-test.md`.

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
