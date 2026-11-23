import { invoke } from '@tauri-apps/api/core';
import { localTrackId, videoIdFromTrackId, youtubeTrackId } from '../library/ids';
import type { Track } from '../library/types';

/**
 * The native seam for turning a Track into a loopback URL.
 *
 * This is the only module that knows the command names; PlayerController only sees
 * `resolveSource(track) -> Promise<string>`. No media server contract changes are needed.
 */

interface ResolvedTrackResponse {
  url: string;
  title: string;
  duration: number;
  video_id: string;
  path: string;
}

interface ResolvedSource {
  url: string;
  path: string | null;
}

/** A resolve already performed for metadata (title/duration) is reused by playTrack. */
const resolvedSources = new Map<string, ResolvedSource>();

/** Resolve a YouTube URL, producing the Track metadata the duration policy depends on. */
export async function resolveYouTubeTrack(url: string): Promise<Track> {
  const result = await invoke<ResolvedTrackResponse>('resolve_track', { url });
  const id = youtubeTrackId(result.video_id);

  const track: Track = {
    id,
    title: result.title,
    artist: null,
    album: null,
    durationSec: finiteDuration(result.duration),
    source: 'youtube',
    artUrl: null,
    filePath: null,
    addedAt: Date.now(),
  };

  resolvedSources.set(id, { url: result.url, path: result.path ?? null });
  return track;
}

/**
 * Canonicalize a picked file, register it for playback, and build a local Track.
 *
 * The id hashes the canonical path, not the dialog's spelling of it. The path is
 * canonicalized in Rust so symlinks and `..` cannot create two ids for one file.
 */
export async function importLocalTrack(path: string): Promise<Track> {
  const canonicalPath = await invoke<string>('canonicalize_local_file', { path });
  const url = await invoke<string>('register_local_file', { path: canonicalPath });
  const id = await localTrackId(canonicalPath);

  const track: Track = {
    id,
    title: basename(canonicalPath),
    artist: null,
    album: null,
    durationSec: 0,
    source: 'local',
    artUrl: null,
    filePath: canonicalPath,
    addedAt: Date.now(),
  };

  resolvedSources.set(id, { url, path: canonicalPath });
  return track;
}

/** PlayerController's resolver. Reuses a recent resolution when one exists. */
export async function resolveTrackSource(track: Track): Promise<string> {
  const cached = resolvedSources.get(track.id);
  if (cached) return cached.url;

  if (track.source === 'youtube') {
    const videoId = videoIdFromTrackId(track.id);
    const result = await invoke<ResolvedTrackResponse>('resolve_track', {
      url: `https://www.youtube.com/watch?v=${encodeURIComponent(videoId)}`,
    });
    resolvedSources.set(track.id, { url: result.url, path: result.path ?? null });
    return result.url;
  }

  if (!track.filePath) throw new Error('local track has no file path');
  const url = await invoke<string>('register_local_file', { path: track.filePath });
  resolvedSources.set(track.id, { url, path: track.filePath });
  return url;
}

/**
 * Paths that must survive cache eviction. Local files live outside the cache, but the
 * resolved YouTube file is in it and must not be deleted while it is playing.
 */
export function keepPathsForTrack(track: Track | null): string[] {
  if (!track) return [];
  const paths = new Set<string>();
  if (track.filePath) paths.add(track.filePath);
  const cached = resolvedSources.get(track.id);
  if (cached?.path) paths.add(cached.path);
  return [...paths];
}

/** After eviction, only protections passed to cache_evict still have a trustworthy URL. */
export function retainResolvedSources(keepPaths: string[]): void {
  const keep = new Set(keepPaths);
  for (const [id, source] of resolvedSources) {
    if (!source.path || !keep.has(source.path)) resolvedSources.delete(id);
  }
}

function finiteDuration(value: number): number {
  return Number.isFinite(value) && value > 0 ? value : 0;
}

function basename(path: string): string {
  const name = path.split(/[\\/]/).pop();
  return name && name.length > 0 ? name : 'local file';
}