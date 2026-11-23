# Spec: media server

**File:** `src-tauri/src/media_server.rs`
**Status:** implemented (Day 1 spike), unit-tested

## Purpose

Serve media bytes to the webview over loopback HTTP with CORS and real Range support,
without ever accepting a caller-supplied filesystem path.

## Contract

- `MediaServer::start() -> io::Result<MediaServer>` — binds `127.0.0.1:0`, spawns the
  accept loop, returns handle with the ephemeral port and a 48-hex-char session token.
- `register(PathBuf) -> String` — returns an opaque 32-hex-char id; idempotent per path.
- `url_for(&str) -> String` — `http://127.0.0.1:<port>/m/<token>/<id>`.

Routes: `GET|HEAD /m/<token>/<id>`. Everything else is 404/405.

## Invariants

1. No path, filename, or query value from the request ever reaches the filesystem.
   The only looked-up value is `id` in an in-memory map.
2. Token comparison is constant-time and length-checked.
3. `id` must be pure hex; anything else is rejected before the map lookup.
4. Responses always include `Access-Control-Allow-Origin: *` so Web Audio can read the
   samples. This is safe because the response body is audio the user already has locally
   and the URL is unguessable.
5. `Cache-Control: no-store`.
6. Range: single range only; clamped to file length; unsatisfiable → full 200.

## Error cases

| Condition | Status |
|---|---|
| wrong/missing token | 401 |
| malformed id | 400 |
| unknown id | 404 |
| missing file on disk | 404 |
| non-GET/HEAD | 405 |

## Test list (all passing)

- [x] `bytes=0-99`, `bytes=500-`, `bytes=-100` parse correctly
- [x] out-of-range and inverted ranges rejected
- [x] multi-range rejected (falls back to 200)
- [x] live server returns 206 + `Content-Range` + CORS header over a real socket
- [x] wrong token → 401
- [x] traversal-shaped id → 400

## Known limits

The token is in the URL path because `<audio>` cannot set headers. Any local process
that reads the URL can fetch the same bytes. Mitigation is scope, not secrecy: audio
only, `no-store`, ephemeral port, token rotates per launch. Recorded in the threat model.
