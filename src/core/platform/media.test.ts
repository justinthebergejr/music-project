import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ invoke: vi.fn() }));

vi.mock('@tauri-apps/api/core', () => ({ invoke: mocks.invoke }));

import { keepPathsForTrack, resolveTrackSource, resolveYouTubeTrack, retainResolvedSources } from './media';

beforeEach(() => {
  mocks.invoke.mockReset();
});

describe('media resolution cache', () => {
  it('resolves a YouTube track once and protects its cache path', async () => {
    mocks.invoke.mockResolvedValue({
      url: 'http://127.0.0.1/m/token/1',
      title: 'A track',
      duration: 191.4,
      video_id: 'abc123',
      path: '/cache/abc123.m4a',
    });

    const track = await resolveYouTubeTrack('https://www.youtube.com/watch?v=abc123');

    expect(track.id).toBe('yt:abc123');
    expect(track.durationSec).toBeCloseTo(191.4);
    expect(keepPathsForTrack(track)).toEqual(['/cache/abc123.m4a']);

    const url = await resolveTrackSource(track);
    expect(url).toBe('http://127.0.0.1/m/token/1');
    expect(mocks.invoke).toHaveBeenCalledTimes(1);
  });

  it('drops unprotected sources after eviction so a deleted file is not reused', async () => {
    mocks.invoke.mockResolvedValue({
      url: 'http://127.0.0.1/m/token/2',
      title: 'Another track',
      duration: 120,
      video_id: 'def456',
      path: '/cache/def456.m4a',
    });

    const track = await resolveYouTubeTrack('https://www.youtube.com/watch?v=def456');
    expect(keepPathsForTrack(track)).toEqual(['/cache/def456.m4a']);

    retainResolvedSources(['/cache/something-else.m4a']);
    expect(keepPathsForTrack(track)).toEqual([]);

    mocks.invoke.mockClear();
    await resolveTrackSource(track);
    expect(mocks.invoke).toHaveBeenCalledTimes(1);
  });
});