# Security checklist and tests

Status legend: **tested** = automated test in the repo · **manual** = verified by hand,
steps recorded · **todo** = not done yet.

| ID | Control | Status | Evidence |
|---|---|---|---|
| S1 | yt-dlp invoked with argv arrays only, never a shell; `--` before positionals; URL host allowlist; whitespace/control characters rejected | tested | `sidecar::tests::*` |
| S2 | Media server serves opaque ids from an in-memory map; no request value reaches the filesystem | tested | `media_server::tests::serves_ranges_with_cors_and_rejects_bad_tokens` |
| S3 | Loopback only, ephemeral port, per-launch token, `no-store`, GET/HEAD only | tested + manual | socket test asserts 401/400; `lsof` shows `127.0.0.1:<port>` |
| S4 | No `innerHTML` for lyric text; TTML tag whitelist | todo | planned with the lyrics module |
| S5 | Parser DoS caps (size, line count, word count), linear-time parse | todo | planned with the lyrics module |
| S6 | No API keys in the client | todo | gitleaks in CI |
| S7 | Network egress allowlist, no generic `fetch_url` command exposed | partial | only GitHub (bootstrap) and yt-dlp (resolver) exist so far |
| S8 | Rate limiting and caching for third-party APIs | todo | planned with lyrics providers |
| S9 | Supply chain: checksums for downloaded binaries | tested (binaries) / todo (Actions pinning) | `bootstrap::tests::checksums_are_rejected_on_mismatch` |
| S10 | Tauri least privilege: only `dialog:allow-open` beyond core | manual | `capabilities/default.json` |
| S11 | Strict production CSP, separate dev CSP | manual | `tauri.conf.json` |
| S12 | No telemetry; redact signed URLs in logs | partial | no telemetry exists yet; log redaction todo |
| S13 | Honest privacy claim ("no account" ≠ "no tracking") | manual | README, threat model |
| S14 | Irreversible actions confirm first | todo | cache clear not built yet |
| **S15** | **Remote binary install: HTTPS only, pinned repo, SHA-256 verified, `.part` then rename, `--version` probe, `.bak` rollback** | tested | `bootstrap::tests::installs_and_verifies_a_runnable_binary` |
| **S16** | **Never prefer an unverified `PATH` binary** | manual | `bootstrap::ensure` has no system fallback; `locate` uses it last |
| **S17** | **Core boundaries: `core/**` cannot import React; only `core/platform` may import `@tauri-apps/*`** | tested + manual | `npm run lint`; a deliberate `react` + `@tauri-apps` probe in `core/library` exits 1 |
| **S18** | **Library writes are atomic and path-confined: temp → fsync → rename; only `library.json` directly in app data; symlinks refused** | tested | `library_fs::tests::*`; `validate_library_path` |
| **S19** | **Cache eviction is confined to the app media cache: regular direct children only, `.part`/`.ytdl` skipped, `keepPaths` protected, evicted ids forgotten** | tested | `media_cache::tests::*`; `media_server::tests::forget_paths_makes_an_existing_url_404` |
| **S20** | **Playback concurrency: at most one Blob/object URL in flight, a stale resolve cannot start playback, object URLs are revoked on replace and dispose** | tested | `PlayerController.test.ts` concurrent + dispose cases |

## How to re-run the automated part

```bash
cargo test --manifest-path src-tauri/Cargo.toml
cargo test --manifest-path src-tauri/Cargo.toml -- --ignored --nocapture   # network
npm run build               # typecheck + bundle
npm run lint                # core import boundaries
npm test                    # Vitest: library, ids, controller, cache-path glue
```

The boundary rule can be re-proved in one command: add
`src/core/library/__probe.ts` containing `import React from 'react'` and
`import { invoke } from '@tauri-apps/api/core'`, then run
`npx eslint src/core/library/__probe.ts` — it must exit non-zero. Delete the probe.

## Known gaps to close before the write-up

1. Actions are pinned to tags, not commit SHAs (`build.yml`). S9 is incomplete until fixed.
2. `capabilities/default.json` will need scoping as plugins are added — review every
   addition, do not accept a generated default.
3. CSP has not yet been exercised against a deliberate injection. Add the canary test
   when lyrics rendering exists (S4/S11).
4. No dependency audit in CI yet (`cargo audit`, `npm audit`, `cargo deny`).
5. The analyser-peak and single-`AudioContext` checks still need a real webview; there is
   no WebDriver harness yet. Steps are recorded in `day1-smoke-test.md`.
6. `cache_evict` is called once per played track, not on a timer. A long single-track
   session can stay above the cap until the next track starts; the protected playing file
   is never deleted.
