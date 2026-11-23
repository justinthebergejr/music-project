import { LIBRARY_VERSION, defaultSettings, emptyLibrary, isRecord } from './types';
import type { Library, Playlist, Settings, Track } from './types';
import { EQ_GAIN_COUNT } from './types';

/**
 * Turn anything that came off disk into a valid Library.
 *
 * Lenient on individual records (drop what cannot be played), strict on the shape the
 * rest of the app relies on (arrays exist, settings always have ten bands).
 */
export function normalizeLibrary(value: unknown): Library {
  if (!isRecord(value)) return emptyLibrary();

  const tracks = Array.isArray(value.tracks)
    ? value.tracks.map(normalizeTrack).filter((track): track is Track => track !== null)
    : [];

  const knownIds = new Set(tracks.map((track) => track.id));
  const playlists = Array.isArray(value.playlists)
    ? value.playlists.map(normalizePlaylist).filter((playlist): playlist is Playlist => playlist !== null)
    : [];

  return {
    version: LIBRARY_VERSION,
    tracks,
    playlists: playlists.map((playlist) => ({
      ...playlist,
      trackIds: [...new Set(playlist.trackIds)].filter((id) => knownIds.has(id)),
    })),
    settings: normalizeSettings(value.settings),
  };
}

export function normalizeSettings(value: unknown): Settings {
  const record = isRecord(value) ? value : {};
  const fallback = defaultSettings();
  const gains = Array.isArray(record.eqGains) ? record.eqGains : [];

  return {
    volume: clamp(finiteNumber(record.volume, fallback.volume), 0, 1),
    eqGains: Array.from({ length: EQ_GAIN_COUNT }, (_, index) =>
      clamp(finiteNumber(gains[index], 0), -12, 12),
    ),
  };
}

function normalizeTrack(value: unknown): Track | null {
  if (!isRecord(value)) return null;

  const id = nonEmptyString(value.id);
  if (!id) return null;

  const source = value.source === 'youtube' || value.source === 'local' ? value.source : null;
  if (!source) return null;
  if (source === 'youtube' && !id.startsWith('yt:')) return null;
  if (source === 'local' && !id.startsWith('local:')) return null;

  return {
    id,
    title: nonEmptyString(value.title) ?? 'Unknown title',
    artist: optionalString(value.artist),
    album: optionalString(value.album),
    durationSec: Math.max(0, finiteNumber(value.durationSec, 0)),
    source,
    artUrl: optionalString(value.artUrl),
    filePath: optionalString(value.filePath),
    addedAt: finiteNumber(value.addedAt, 0),
  };
}

function normalizePlaylist(value: unknown): Playlist | null {
  if (!isRecord(value)) return null;
  const id = nonEmptyString(value.id);
  if (!id) return null;
  const trackIds = Array.isArray(value.trackIds)
    ? value.trackIds.filter((trackId): trackId is string => typeof trackId === 'string' && trackId.length > 0)
    : [];
  return {
    id,
    name: nonEmptyString(value.name) ?? 'Untitled playlist',
    trackIds,
  };
}

function finiteNumber(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value : null;
}

function optionalString(value: unknown): string | null {
  return nonEmptyString(value);
}