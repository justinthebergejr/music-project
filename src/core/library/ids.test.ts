import { describe, expect, it } from 'vitest';
import { localTrackId, videoIdFromTrackId, youtubeTrackId } from './ids';

describe('deterministic track ids', () => {
  it('is stable for the same canonical path', async () => {
    const first = await localTrackId('/Users/example/Music/Album/01 Track.flac');
    const second = await localTrackId('/Users/example/Music/Album/01 Track.flac');
    expect(first).toBe(second);
    expect(first.startsWith('local:')).toBe(true);
  });

  it('is stable for the same video id', () => {
    expect(youtubeTrackId('dQw4w9WgXcQ')).toBe('yt:dQw4w9WgXcQ');
    expect(youtubeTrackId('dQw4w9WgXcQ')).toBe(youtubeTrackId('dQw4w9WgXcQ'));
  });

  it('differs across sources for the same payload', async () => {
    const youtube = youtubeTrackId('shared-value');
    const local = await localTrackId('shared-value');
    expect(youtube).not.toBe(local);
    expect(youtube).toBe('yt:shared-value');
    expect(local).toMatch(/^local:[0-9a-f]{64}$/);
  });

  it('different paths produce different ids', async () => {
    const one = await localTrackId('/music/a.flac');
    const two = await localTrackId('/music/b.flac');
    expect(one).not.toBe(two);
  });

  it('extracts the video id without accepting a local id', () => {
    expect(videoIdFromTrackId('yt:abc123')).toBe('abc123');
    expect(() => videoIdFromTrackId('local:abc123')).toThrow();
  });

  it('rejects empty input instead of inventing an id', async () => {
    expect(() => youtubeTrackId('  ')).toThrow();
    await expect(localTrackId('   ')).rejects.toThrow();
  });
});