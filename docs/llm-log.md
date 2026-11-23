# LLM bug log

Every entry is a defect that was generated, accepted or nearly accepted, how it surfaced,
and what now prevents it. This is evidence for the "review and debug LLM output" part of
the grade, not a highlight reel.

Format: **context → what the code did → how it was found → fix → regression test.**

---

## 1. URL validation assumed the parser would reject flag-shaped input

**Context:** `sidecar.rs::validate_url`, first draft.

**What the code did:** rejected anything the `url` crate refused to parse. I wrote a test
asserting that `https://www.youtube.com/watch?v=x --exec=touch /tmp/owned` would be
rejected. It was not: `Url::parse` percent-encodes the spaces and returns `Ok`.

**How it was found:** the test failed on first run. The *code* was still safe — the value
is passed as a single argv entry after `--`, so nothing could reinterpret it as a flag —
but the stated intent ("this cannot be a flag") was not enforced anywhere.

**Fix:** explicit rejection of whitespace and control characters before parsing, so the
invariant is enforced by the code and not by a comment.

**Regression test:** `sidecar::tests::flag_shaped_input_is_not_accepted_as_a_url`.

**Why it matters:** this is the difference between "it happens to be safe" and "it is
safe for a reason someone can check."

---

## 2. Binary lookup trusted `PATH` (worked in dev, failed in the real app)

**Context:** `lib.rs::yt_dlp_path`, first draft.

**What the code did:** checked next to the executable, then fell back to
`PathBuf::from("yt-dlp")`. In `tauri dev` this works, because the app inherits the
developer's shell environment.

**How it was found:** the first bundled launch showed
`could not run yt-dlp: No such file or directory (os error 2)`. A GUI app launched from
Finder gets a minimal `PATH` (`/usr/bin:/bin:/usr/sbin:/sbin`) and does not see
`/usr/local/bin`, so the fallback silently resolves to nothing.

**Fix:** the toolchain is now installed and verified by the app (`bootstrap.rs`), with
explicit search of known locations and an expanded `PATH` as a last resort.

**Regression test:** `bootstrap::tests::installs_and_verifies_a_runnable_binary`
(`--ignored`, network) proves a clean directory ends up with a runnable binary.

**Why it matters:** the bug only exists in the deployment shape, not the development
shape. This is why Day 1 requires a built bundle, not `tauri dev`.

---

## 3. Preferring any `yt-dlp` on `PATH` was a code-execution vector

**Context:** my own follow-up to #2. The first fixed version used a system binary when
one existed.

**What the code did:** ran whatever `yt-dlp` it found first, including a user-writable
directory on `PATH`, without verifying anything.

**How it was found:** security review of my own change, not a test failure. Any process
that can write to a `PATH` entry — a malicious installer, a wrongly-permissioned
`~/.local/bin` — gets code execution inside the app with the user's privileges.

**Fix:** the managed, checksum-pinned copy is always preferred; `PATH` is only consulted
after a failed bootstrap. Update path keeps the old binary as `.bak` and probes the
candidate before promotion.

**Regression test:** checksum mismatch must delete the download
(`bootstrap::tests::checksums_are_rejected_on_mismatch`).

**Why it matters:** the fix for #2 introduced a worse problem than the one it solved.
Reviewing my own patch found it; the compiler and the demo would not have.

---

## 4. Bootstrap was untestable because it depended on `AppHandle`

**Context:** first version of `bootstrap.rs`.

**What the code did:** took a `tauri::AppHandle` to resolve the app data directory and to
emit progress. Correct, but impossible to exercise without a running webview.

**How it was found:** attempting to verify the download path headlessly produced no
output at all, and the only way to test it was through the GUI.

**Fix:** `ensure(data_dir, force, report)` takes a directory and a callback. Tauri is now
the caller, not a dependency. The download path is covered by a real (ignored) test.

**Regression test:** the `--ignored` install test above.

**Why it matters:** the security-critical code became testable *because* it stopped
depending on the framework. Testability and reviewability were the same change.

---

## 5. Frontend install depended on an event subscription succeeding

**Context:** `App.tsx`, launch effect.

**What the code did:** `unlisten = await onToolchainStatus(handle)` before calling
`ensureToolchain()`, with no `try` around the first call.

**How it was found:** reading my own code while writing the failure modes down. If event
registration throws (capability mistake, CSP mistake), the promise rejects inside a
`void async` IIFE, the error is swallowed, and the install never runs — with a spinner
that never resolves.

**Fix:** subscription is best-effort inside its own `try`; the returned status is
authoritative.

**Regression test:** manual — disable the event capability and confirm the install still
completes.

**Why it matters:** unhandled rejections in `void (async () => …)()` are invisible in
production. Two independent mechanisms now carry the same information.
