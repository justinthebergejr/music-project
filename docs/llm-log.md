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

---

## 6. Parsed yt-dlp output by position — `after_move` prints last

**Context:** `sidecar.rs::resolve_audio`.

**What the code did:** assumed a fixed field order and read
`lines[n-4] → path`, `lines[n-3] → title`, and so on.

**How it was found:** running the exact production argv by hand. The real order is
`title, duration, id, filepath` — the `after_move` stage is evaluated after the metadata
prints, so the file path is always the *last* line. My parse would have taken the title
as the path and failed with "resolved file missing".

**Fix:** each field is printed with a `MALICE_*=` tag and parsed by prefix, so field
order cannot matter. A missing path or `NA` is an explicit error rather than a guess.

**Regression test:** `sidecar::tests::print_output_is_parsed_regardless_of_field_order`,
`sidecar::tests::missing_path_is_an_error_not_a_guess`.

**Why it matters:** this path had never executed in the app, because resolution failed
earlier for an unrelated reason. A single hand-run of the real command found it in
30 seconds; the UI would never have surfaced it as clearly.

---

## 7. Trusted `HTMLMediaElement.duration`, and assumed yt-dlp wrote a normal M4A

**Context:** a 3:11 track displayed as 6:22 — exactly double.

**What the code did:** `loadedmetadata` copied `audio.duration` into the UI and treated it
as the truth, overriding the duration the resolver already knew.

**How it was found:** the user reported 6:22 for a 3:11 song. The cached file measured
191.4 s with both `ffprobe` and `afinfo`, and the loopback responses had a single correct
`Content-Length` with no chunking — so neither the bytes nor the transport were at fault.
Dumping the MP4 box layout showed the cause: yt-dlp had saved YouTube's DASH audio as a
**fragmented MP4** (`moov` + `sidx` + 19 `moof`/`mdat` pairs). WebKit's incremental fMP4
path miscomputes duration for that layout; the complete file parses correctly.

**Fix:** two independent layers.

1. The element is fed a complete `Blob` instead of a byte stream, so it never needs the
   incremental fMP4 path (cached tracks are already fully downloaded, so this costs
   nothing; files over 64 MB stay on HTTP to bound memory).
2. Metadata duration wins whenever the element disagrees by more than 5%, and the
   mismatch is logged and shown in the UI. The display cannot be wrong even if the
   engine's parse is.

**Regression test:** none automated yet — this needs an engine-level test harness
(WebDriver). Recorded as a gap in `security-tests.md`; the manual step is the duration
check in the Day 1 matrix.

**Why it matters:** the file, the server, and the client were each individually correct.
The bug lived in the *combination* — which is exactly the class of defect that only a
real playback test catches.

---

## 8. A literal ESLint boundary banned the only sanctioned native seam

**Context:** Step 4, `eslint.config.js`, first draft.

**What the code did:** applied `no-restricted-imports` for `@tauri-apps/*` to all of
`src/core/**`. That is the rule as written in the task, but `src/core/platform` exists
precisely to import `invoke()` and the Tauri path API.

**How it was found:** applying the rule literally to the existing tree flags
`src/core/platform/toolchain.ts`, plus the new `media.ts`, `cache.ts`, and
`libraryStorage.ts`. A rule that fails the documented boundary is not enforcing the
boundary; it is banning it.

**Fix:** two configs. React is banned in all of `core/**`; `@tauri-apps/*` is banned in
`core/**` except `core/platform/**`. The single exception is recorded in
`docs/architecture.md` and in the spec, rather than left implicit in the config.

**Regression test:** a temporary `src/core/library/__probe.ts` importing both `react` and
`@tauri-apps/api/core` produces two errors and exits 1; `npm run lint` passes after it is
removed. Recorded as S17 in `security-tests.md`.

**Why it matters:** a lint rule that fails correct code gets disabled or ignored, and the
next real violation gets ignored with it.

---

## 9. Cache eviction could delete the file currently playing

**Context:** Step 3, wiring `keepPaths` to the player.

**What the code did:** the obvious `keepPaths` source was `track.filePath`, which is
`null` for every YouTube track. The resolved cache path existed only inside Rust and was
never returned to the frontend, so the LRU saw the currently playing file as an ordinary
old entry. Serving a Range request does not update mtime, so it would also look like the
oldest entry.

**How it was found:** tracing a YouTube track through resolve → play → `cache_evict`
while writing the Step 3 spec. The requirement says eviction needs Step 2's notion of
"currently playing", and `track.filePath` cannot express that for a cached YouTube track.

**Fix:** `resolve_track` now returns the canonical cache path. `core/platform/media.ts`
records it per track id, and `keepPathsForTrack()` returns the local path and/or the cache
path. `media_cache::evict` skips `keepPaths`; `MediaServer::forget_paths` removes ids for
files it did delete. After eviction, unprotected resolved URLs are dropped so a deleted
file is not handed to the element again.

**Regression test:** `media_cache::tests::protected_paths_survive_even_when_the_cap_is_exceeded`,
`media_server::tests::forget_paths_makes_an_existing_url_404`, and
`src/core/platform/media.test.ts` (one resolve reused, path protected, dropped after
eviction).

**Why it matters:** "currently playing" is not the same as `track.filePath`; the cache path
is an implementation detail that had to cross the boundary deliberately.

---

## 10. Awaiting the resolver before `engine.resume()` loses the user gesture

**Context:** `PlayerController.playTrack`, first sketch.

**What the code did:** followed the old `App.tsx` shape — `await resolveSource()`, prepare
the Blob, then `await engine.resume()` and `element.play()`. A YouTube resolve takes 1–2
seconds, so the click's transient activation is gone by the time the context is resumed.

**How it was found:** reviewing the click handler → async gap against the audio-engine
contract ("`AudioContext.resume()` happens inside a real user gesture"). The Day 1 code
happened to work, but moving the logic into a class made the ordering easy to lose.

**Fix:** call `engine.resume()` synchronously at the top of `playTrack`, before the first
`await`, and await the same promise after preparation. A no-op catch is attached so an
early resolver error does not leave an unhandled rejection.

**Regression test:** `PlayerController.test.ts` — "starts engine.resume before the
resolver can await" asserts the resolver observes `resumed === true`.

**Why it matters:** this is a timing contract that the type system cannot express and the
old component shape did not document.

---

## 11. `fs::write` would truncate the library in place

**Context:** `library_fs.rs`, first design.

**What the code did:** the obvious implementation is `fs::write(path, json)`. It opens the
target with truncate, so a crash or `ENOSPC` after truncation leaves a zero-length or
partial `library.json` — exactly the failure the spec forbids.

**How it was found:** writing the crash requirement into the spec, then asking what test
distinguishes the two implementations. A test that fails *before* the write starts would
pass for `fs::write` too. The test has to fail **inside** the write.

**Fix:** `atomic_write_with` creates/truncates `<file>.tmp`, writes, calls `sync_all`,
renames over the target, and fsyncs the parent on Unix. Any error removes the temp file.
The target path is only ever produced by the rename.

**Regression test:** `library_fs::tests::a_failed_write_never_truncates_the_previous_target`
injects a writer that writes 18 bytes and then returns an error; the old bytes survive and
no `.tmp` remains. `atomic_write_leaves_a_complete_file_and_no_temp` covers the success
path.

**Why it matters:** atomicity is a property of the syscall sequence, not of a function
name; the test has to be able to fail mid-write.

---

## 12. The concurrency token did not bound Blob memory

**Context:** `PlayerController.playTrack`, first concurrency sketch.

**What the code did:** gave every call a sequence token, resolved both, then checked the
token before attaching. That prevents stale *playback*, but two quick clicks could still
both `fetch` and both call `URL.createObjectURL`; the second assignment overwrote
`objectUrl` and leaked the first blob.

**How it was found:** reviewing the "never hold more than one Blob at a time" requirement
against the token sketch. A token answers "who may play?", not "how many blobs exist?".

**Fix:** each preparation gets an `AbortController`; starting a newer `playTrack` aborts
the previous fetch. A stale result revokes its own object URL. `attachSource` revokes the
previous object URL only after assigning and loading the new `src`, so it cannot abort the
load that is still current.

**Regression test:** the concurrent `playTrack` test asserts exactly one `play()` call and
exactly one `createObjectURL` call; the dispose test asserts the active URL is revoked;
`media.test.ts` covers the one-resolve cache path.

**Why it matters:** cancellation, playback ordering, and memory lifetime are three
separate obligations; a single sequence token only covers the middle one.
