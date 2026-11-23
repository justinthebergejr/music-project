import { describe, expect, it } from 'vitest';
import { loadLibrary, saveLibrary, upsertTrack, removeTrack } from './repo';
import { emptyLibrary, type Library, type LibraryIO, type Track } from './types';

class MemoryIO implements LibraryIO {
  contents: string | null;
  backups = 0;
  writes = 0;
  failNextWrite = false;

  constructor(contents: string | null = null) {
    this.contents = contents;
  }

  async read(): Promise<string | null> {
    return this.contents;
  }

  /**
   * Stand-in for the Rust primitive: a write only becomes visible when it completes.
   * The real fsync + rename invariant is tested in `library_fs::tests`.
   */
  async writeAtomic(contents: string): Promise<void> {
    this.writes += 1;
    if (this.failNextWrite) {
      this.failNextWrite = false;
      throw new Error('simulated disk full');
    }
    this.contents = contents;
  }

  async backup(): Promise<void> {
    this.backups += 1;
  }
}

const TRACK: Track = {
  id: 'yt:dQw4w9WgXcQ',
  title: 'Never Gonna Give You Up',
  artist: 'Rick Astley',
  album: null,
  durationSec: 191.4,
  source: 'youtube',
  artUrl: null,
  filePath: null,
  addedAt: 1_700_000_000_000,
};

function libraryWith(track: Track): Library {
  return {
    version: 1,
    tracks: [track],
    playlists: [{ id: 'playlist-1', name: 'Test mix', trackIds: [track.id] }],
    settings: { volume: 0.65, eqGains: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10] },
  };
}

describe('library repo', () => {
  it('round-trips tracks, playlists and settings', async () => {
    const io = new MemoryIO();
    const library = libraryWith(TRACK);

    await saveLibrary(library, io);
    const loaded = await loadLibrary(io);

    expect(loaded).toEqual(library);
  });

  it('does not expose a partial document when a write fails', async () => {
    const io = new MemoryIO();
    const library = libraryWith(TRACK);
    await saveLibrary(library, io);
    const before = io.contents;

    io.failNextWrite = true;
    await expect(saveLibrary(library, io)).rejects.toThrow('simulated disk full');

    expect(io.contents).toBe(before);
    expect(await loadLibrary(io)).toEqual(library);
  });

  it('falls back to defaults and keeps a .bak for an unknown version', async () => {
    const original = JSON.stringify({ version: 99, tracks: [TRACK], playlists: [], settings: {} });
    const io = new MemoryIO(original);

    const loaded = await loadLibrary(io);

    expect(loaded).toEqual(emptyLibrary());
    expect(io.backups).toBe(1);
    expect(io.contents).toBe(original);
  });

  it('falls back to defaults and keeps a .bak for invalid JSON', async () => {
    const io = new MemoryIO('{"version":1,"tracks":[');

    const loaded = await loadLibrary(io);

    expect(loaded).toEqual(emptyLibrary());
    expect(io.backups).toBe(1);
    expect(io.contents).toBe('{"version":1,"tracks":[');
  });

  it('returns defaults without inventing a backup when the read fails', async () => {
    let backups = 0;
    const io: LibraryIO = {
      read: async () => {
        throw new Error('permission denied');
      },
      writeAtomic: async () => {},
      backup: async () => {
        backups += 1;
      },
    };

    const loaded = await loadLibrary(io);

    expect(loaded).toEqual(emptyLibrary());
    expect(backups).toBe(0);
  });

  it('normalizes settings to ten clamped bands', async () => {
    const io = new MemoryIO(
      JSON.stringify({
        version: 1,
        tracks: [],
        playlists: [],
        settings: { volume: 4, eqGains: [99, -99, 1] },
      }),
    );

    const loaded = await loadLibrary(io);

    expect(loaded.settings.volume).toBe(1);
    expect(loaded.settings.eqGains).toHaveLength(10);
    expect(loaded.settings.eqGains[0]).toBe(12);
    expect(loaded.settings.eqGains[1]).toBe(-12);
    expect(loaded.settings.eqGains.slice(2)).toEqual([1, 0, 0, 0, 0, 0, 0, 0]);
  });

  it('upserts by deterministic id and removes from playlists', () => {
    const library = libraryWith(TRACK);
    const updated = upsertTrack(library, { ...TRACK, title: 'Updated title' });

    expect(updated.tracks).toHaveLength(1);
    expect(updated.tracks[0].title).toBe('Updated title');

    const removed = removeTrack(updated, TRACK.id);
    expect(removed.tracks).toHaveLength(0);
    expect(removed.playlists[0].trackIds).toEqual([]);
  });
});