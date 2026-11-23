import type { AudioEngine } from '../audio/AudioEngine';
import type { Track } from '../library/types';

export type PlayerState = 'idle' | 'loading' | 'playing' | 'paused' | 'ended' | 'error';

export type RepeatMode = 'off' | 'one' | 'all';

export type PlayerErrorCode = 'resolve' | 'decode' | 'aborted' | 'unknown';

export interface PlayerError {
  code: PlayerErrorCode;
  message: string;
}

export interface PlayerSnapshot {
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

export interface PlayerControllerOptions {
  engine: AudioEngine;
  resolveSource: (track: Track) => Promise<string>;
}