# Spec: player controller

**File:** `src/core/player/PlayerController.ts` (+ `types.ts`, `index.ts`)
**Status:** implemented (Day 2)

## Purpose

Own exactly one audio element and all playback decisions, so React can render from a
snapshot instead of managing an element. The controller is plain TypeScript: no React,
no `@tauri-apps/*`, no DOM ownership outside its own `new Audio()`.

The media server contract does **not** change. `resolveSource(track)` returns an existing
loopback URL (from `resolve_track` or `register_local_file`); the controller only chooses
whether to hand the element that URL or a Blob of it.

## Public API

```ts
type PlayerState = 'idle' | 'loading' | 'playing' | 'paused' | 'ended' | 'error';
type RepeatMode = 'off' | 'one' | 'all';

interface PlayerError {
  code: 'resolve' | 'decode' | 'aborted' | 'unknown';
  message: string;
}

interface PlayerSnapshot {
  state: PlayerState;
  track: Track | null;
  positionSec: number;
  durationSec: number;
  queue: Track[];
  index: number;
  shuffle: boolean;
  repeat: RepeatMode;
  error: PlayerError | null;
}

class PlayerController {
  constructor(opts: { engine: AudioEngine; resolveSource: (track: Track) => Promise<string> });
  subscribe(listener: () => void): () => void;
  getSnapshot(): PlayerSnapshot;
  playTrack(track: Track, queue?: Track[]): Promise<void>;
  play(): Promise<void>;
  pause(): void;
  next(): Promise<void>;
  previous(): Promise<void>;
  seek(sec: number): void;
  setVolume(value: number): void;
  setShuffle(on: boolean): void;
  setRepeat(mode: RepeatMode): void;
  dispose(): void;
}
```

`subscribe` and `getSnapshot` are arrow properties so they can be passed directly to
`useSyncExternalStore` without binding. `getSnapshot()` returns the cached object and does
not build a new one; a new object is produced only when state actually changes.

## Element ownership

- The constructor creates `new Audio()` and calls `engine.attach(element)` exactly once.
  A second attach is forbidden by the `AudioEngine` contract and would silently do
  nothing while leaving the new element unconnected.
- React never creates an audio element, never calls `createMediaElementSource`, and never
  reads analyser data for playback decisions.
- The element is detached from the document. `HTMLAudioElement` plays detached; the
  Web Audio source node is what matters.

## State machine

```
idle --playTrack--> loading --play event--> playing
                        |                     |
                        | error               +--pause()--> paused --play()--> playing
                        v                     +--ended--> ended --next/repeat--> loading/playing
                      error
```

- `playTrack` enters `loading` synchronously, before its first `await`, so the UI cannot
  miss the transition.
- The element's `play`, `pause`, `ended`, `error`, `timeupdate`, `seeked`,
  `loadedmetadata` and `durationchange` events drive the rest.
- Operational failures (resolver, blob fetch, decode, autoplay rejection) are reported
  in `snapshot.error` and the promise resolves. `playTrack` never rejects for a normal
  playback failure, which keeps `void controller.play()` from creating unhandled
  rejections. A superseded call reports `aborted` in `snapshot.error`.
- `dispose()` pauses the element, removes every listener, aborts in-flight preparation,
  revokes the active object URL, clears subscribers, and makes all later calls no-ops.

## Duration policy (moved out of App.tsx)

- `durationSec = track.durationSec` when it is greater than zero, otherwise the element's
  duration.
- When both exist and the element is more than 5% above or below the metadata value, the
  metadata value wins. The raw element value is logged with `console.info`, prefixed
  `[player]`, because the Day 1 bug was a 191.4 s track reported as 382.8 s by WebKit's
  incremental fMP4 path.
- The mismatch is logged once per distinct element duration, not on every
  `durationchange`.

## Queue, shuffle, repeat

- `playTrack(track, queue?)` copies the queue if supplied. If the track is not in it, the
  track is prepended. Without a queue, the queue is `[track]`.
- `next()` advances; at the end it wraps when `repeat === 'all'`, otherwise the state
  becomes `ended` and playback stops.
- `previous()` goes back; at the start it restarts the current track, or wraps to the end
  when `repeat === 'all'`.
- `ended` with `repeat === 'one'` seeks to 0 and replays the current track. `next()` is a
  manual action and still advances under `repeat === 'one'`.
- `shuffle` picks a random different index for `next`/`previous`. The queue array itself
  is not reordered, so the snapshot remains a stable queue and "previously played" is
  still meaningful.

## Concurrency

- Every `playTrack` takes a monotonically increasing sequence token. After each `await`,
  it checks that its token is still current. A stale resolve never assigns `src` and
  never calls `play()`; it reports `{ code: 'aborted' }`.
- Starting a new `playTrack` aborts the previous preparation fetch with an
  `AbortController`. This is what guarantees at most one Blob/object URL is in flight,
  even if the first resolver is slow.
- The sequence is also bumped by `dispose()`, so a resolve that finishes after teardown
  cannot start playback.

## Blob policy

Day 1's duration fix depends on feeding WebKit a complete resource for fragmented MP4.
The controller therefore preserves the cache-then-play Blob path:

- `fetch(loopbackUrl)` → `blob()` → `URL.createObjectURL`, capped at 64 MiB.
- If the declared or actual size exceeds the cap, the element is given the loopback URL
  directly and no Blob is held.
- The previous object URL is revoked **after** the new `src` is assigned and `load()` is
  called. Revoking before the assignment can abort the load that is still current.
- A stale preparation revokes its own object URL immediately.

## Ambiguities and chosen boring options

1. **"emit 'aborted'"** — there is no event channel in the API, so the stale call writes
   `error.code = 'aborted'` into the current snapshot and emits. A newer request clears
   it when it successfully starts playing.
2. **`playTrack` rejection semantics** — it resolves for operational failures. The only
   alternative is to reject from fire-and-forget paths (`ended` → `next`), which is a
   documented source of unhandled rejections. Tests inspect `snapshot.error`.
3. **`seek(sec): void`** — position is updated by the element's `seeked`/`timeupdate`
   events, not optimistically. This keeps the Day 1 "seek → 80%" test measuring a real
   media seek rather than a state assignment.
4. **Shuffle** — random selection at navigation time, not a shuffled copy. The queue in
   the snapshot is the queue the user supplied.

## Test list

- [x] idle → loading → playing
- [x] pause / resume
- [x] `ended` advances the queue
- [x] `repeat: 'one'` replays the current track
- [x] resolver rejection sets `error` and does not play
- [x] two concurrent `playTrack` calls produce exactly one playback
- [x] element duration 2× metadata → snapshot uses metadata
- [x] `engine.resume()` starts before the resolver's first `await` (user-gesture safety)
- [x] dispose revokes the object URL and ignores a late resolve

## Out of scope

Playlists UI, crossfade, gapless playback, pitch shifting, media keys, output routing.