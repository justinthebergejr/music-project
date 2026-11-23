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

## How to re-run the automated part

```bash
cargo test --manifest-path src-tauri/Cargo.toml
cargo test --manifest-path src-tauri/Cargo.toml -- --ignored --nocapture   # network
npm run build               # typecheck + bundle
```

## Known gaps to close before the write-up

1. Actions are pinned to tags, not commit SHAs (`build.yml`). S9 is incomplete until fixed.
2. `capabilities/default.json` will need scoping as plugins are added — review every
   addition, do not accept a generated default.
3. CSP has not yet been exercised against a deliberate injection. Add the canary test
   when lyrics rendering exists (S4/S11).
4. No dependency audit in CI yet (`cargo audit`, `npm audit`, `cargo deny`).
