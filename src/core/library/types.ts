/** Domain types for the local library. No framework or native imports belong here. */

export type TrackSource = 'youtube' | 'local';

export interface Track {
  /** 'yt:<videoId>' or 'local:<sha256 of canonical path>' — deterministic, never random. */
  id: string;
  title: string;
  artist: string | null;
  album: string | null;
  /** Authority for the UI duration; 0 means unknown. */
  durationSec: number;
  source: TrackSource;
  artUrl: string | null;
  /** Local files only. Resolved and canonicalized by the native platform module. */
  filePath: string | null;
  /** Epoch milliseconds. */
  addedAt: number;
}

export interface Settings {
  volume: number;
  /** Exactly ten bands, in EQ_BANDS order. dB, -12..12. */
  eqGains: number[];
}

export interface Playlist {
  id: string;
  name: string;
  trackIds: string[];
}

export const LIBRARY_VERSION = 1 as const;

export interface Library {
  version: typeof LIBRARY_VERSION;
  tracks: Track[];
  playlists: Playlist[];
  settings: Settings;
}

/** The only filesystem seam `core/library` is allowed to use. */
export interface LibraryIO {
  read(): Promise<string | null>;
  writeAtomic(contents: string): Promise<void>;
  /** Copy the current document to `<file>.bak`; never move or delete the original. */
  backup(): Promise<void>;
}

export const EQ_GAIN_COUNT = 10;

export function defaultSettings(): Settings {
  return { volume: 1, eqGains: Array.from({ length: EQ_GAIN_COUNT }, () => 0) };
}

export function emptyLibrary(): Library {
  return { version: LIBRARY_VERSION, tracks: [], playlists: [], settings: defaultSettings() };
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}