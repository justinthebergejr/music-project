# Threat model (working draft)

Two pages by Day 13. This is the skeleton plus the entry that matters most.

## System and data flow

```
user → webview (React, renders third-party text)
         │ invoke()                    ▲ GET /m/<token>/<id>
         ▼                            │
      Rust commands ── spawn ──> yt-dlp (downloaded binary)
         │                            │
         └── HTTPS ──> api.github.com, github.com (release assets)
         └── HTTPS ──> googlevideo.com (via yt-dlp), LRCLIB, lyric providers
```

## Assets

| Asset | Why it matters |
|---|---|
| Local audio files | user data; read-only access is a privacy boundary |
| Cache (audio + lyrics) | copyrighted content; must not leave the machine |
| Listening history / queue | behavioural data; app is local-only by design |
| Integrity of the running binary | the app executes a downloaded tool |
| User IP / identity | visible to Google and lyric providers even with no account |

## Trust boundaries

1. **Webview → Rust.** The webview renders text from third parties (lyrics, titles).
   Treat it as semi-trusted: it may be induced to call any exposed command.
2. **Rust → downloaded binary.** Remote code execution by design. Highest risk in the app.
3. **Network → parsers.** Every lyric, title, and metadata field is attacker-controlled.
4. **Loopback port.** Reachable by any local process that learns the URL.

## STRIDE highlights

| Threat | Scenario | Mitigation | Check |
|---|---|---|---|
| **Elevation of privilege** | Tampered `yt-dlp` download executes inside the app | HTTPS + pinned repo + SHA-256 verification from the release metadata, `.part` then rename, `--version` probe before promotion, previous binary kept as `.bak` | `S15` |
| **Elevation of privilege** | A poisoned `yt-dlp` earlier on `PATH` is executed | Never trust `PATH` for the managed path; only used as a last resort when bootstrap failed | `S16` |
| **Tampering** | Crafted LRC/TTML does something other than parse | Whitelist tags, no `innerHTML`, size/count caps | `S4`, `S5` |
| **Spoofing** | Another local process reads media through the loopback server | ephemeral port + per-launch token, `no-store`, audio bytes only | `S3` |
| **Information disclosure** | Logs leak stream URLs (they are signed) | redact query strings before logging | `S12` |
| **Denial of service** | 50 MB lyric file or pathological TTML | caps + linear-time parse | `S5` |
| **Tampering** | Sidecar argument injection via URL or query | argv only, `--` terminator, host allowlist, whitespace rejection | `S1` |

## Residual risks (accepted, documented)

- Downloading and executing a third-party binary at launch is a supply-chain bet on
  GitHub release integrity. Pinning the expected hash in-repo would remove the
  "compromised release" case; not done yet, recorded as future work.
- Unsigned builds. Telling a user to strip the quarantine attribute is itself a risk,
  so the write-up recommends building from source instead.
- No code signing means no auto-update integrity story; updates are manual and out of scope.
- The loopback token appears in the page's media URL, which is visible to anything that
  can read the webview's DOM or logs.

## Out of scope

DRM circumvention, piracy of paid content, defending against a compromised OS or a
compromised local user account, and multi-user isolation.
