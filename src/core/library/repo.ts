import { libraryIO } from '../platform/libraryStorage';
import { normalizeLibrary, normalizeSettings } from './normalize';
import { LIBRARY_VERSION, emptyLibrary, isRecord } from './types';
import type { Library, LibraryIO, Playlist, Settings, Track } from './types';

/**
 * Load the library.
 *
 * An unknown version or unparseable JSON is treated as "this document belongs to a
 * different app version": keep it as `library.json.bak`, then start from defaults. The
 * original is left in place, so a mistaken downgrade is one copy away from recovery.
 *
 * A plain read failure (permissions, missing directory) also returns defaults, but does
 * not pretend there was a document to back up.
 */
export async function loadLibrary(io: LibraryIO = libraryIO): Promise<Library> {
  let text: string | null;
  try {
    text = await io.read();
  } catch (error) {
    console.warn('[library] read failed; starting from defaults', error);
    return emptyLibrary();
  }

  if (text === null || text.trim() === '') return emptyLibrary();

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    await backupQuietly(io);
    return emptyLibrary();
  }

  if (!isRecord(parsed) || parsed.version !== LIBRARY_VERSION) {
    await backupQuietly(io);
    return emptyLibrary();
  }

  return normalizeLibrary(parsed);
}

export async function saveLibrary(library: Library, io: LibraryIO = libraryIO): Promise<void> {
  if (library.version !== LIBRARY_VERSION) {
    throw new Error(`cannot save unsupported library version: ${String(library.version)}`);
  }
  const document = normalizeLibrary(library);
  await io.writeAtomic(JSON.stringify(document, null, 2));
}

export function upsertTrack(library: Library, track: Track): Library {
  const index = library.tracks.findIndex((candidate) => candidate.id === track.id);
  const tracks =
    index === -1
      ? [...library.tracks, track]
      : library.tracks.map((candidate) => (candidate.id === track.id ? track : candidate));
  return { ...library, tracks };
}

export function removeTrack(library: Library, trackId: string): Library {
  return {
    ...library,
    tracks: library.tracks.filter((track) => track.id !== trackId),
    playlists: library.playlists.map((playlist) => ({
      ...playlist,
      trackIds: playlist.trackIds.filter((id) => id !== trackId),
    })),
  };
}

export function upsertPlaylist(library: Library, playlist: Playlist): Library {
  const exists = library.playlists.some((candidate) => candidate.id === playlist.id);
  return {
    ...library,
    playlists: exists
      ? library.playlists.map((candidate) => (candidate.id === playlist.id ? playlist : candidate))
      : [...library.playlists, playlist],
  };
}

export function setSettings(library: Library, settings: Settings): Library {
  return { ...library, settings: normalizeSettings(settings) };
}

async function backupQuietly(io: LibraryIO): Promise<void> {
  try {
    await io.backup();
  } catch (error) {
    console.warn('[library] could not write library.json.bak', error);
  }
}