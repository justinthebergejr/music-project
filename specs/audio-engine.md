# Spec: audio engine

**File:** `src/core/audio/AudioEngine.ts`
**Status:** implemented (Day 1 spike) — reviewed, tests pending in Day 2

## Purpose

Own the single Web Audio graph for the process, and be the only code allowed to create
or mutate audio nodes.

## Public API

```ts
export const EQ_BANDS: readonly number[];          // 10 centre frequencies
export class AudioEngine {
  readonly ctx: AudioContext;
  readonly analyser: AnalyserNode;
  attach(el: HTMLAudioElement): void;              // idempotent, once per element
  resume(): Promise<void>;                          // call inside a user gesture
  setBandGain(index: number, db: number): void;     // -12..12
  setVolume(value: number): void;                   // 0..1
  readFrequency(target: Uint8Array<ArrayBuffer>): void;
  peak(): number;                                   // 0..1, deviation from silence
}
export function getAudioEngine(): AudioEngine;      // process singleton
```

## Invariants

1. One `AudioContext` per process. A second one is a bug, not a feature.
2. `attach()` is idempotent. A second `createMediaElementSource()` on the same element
   throws, and a failed attach leaves the element permanently silent.
3. The graph is built once in the constructor and never rebuilt; track changes only
   mutate `audio.src`.
4. `core/audio/**` never imports React.

## Error cases

- `AudioContext` constructor throws (no audio device): the caller must show a real
  error state, not a spinner.
- `resume()` rejects or leaves `state !== 'running'`: surface it; do not pretend to play.

## Test list

- [ ] `getAudioEngine()` returns the same instance twice (vitest, mocked Web Audio)
- [ ] `attach()` twice does not create a second source node
- [ ] EQ band gain clamps to ±12 dB
- [ ] `peak()` returns 0 for a silent analyser and > 0 for a synthetic buffer

## Out of scope

Pitch shifting, convolver reverb, offlining/rendering, per-device routing.
