/**
 * Deterministic track ids.
 *
 * The same YouTube video id or the same canonical local path must always produce the same
 * id, across launches and across machines. Random ids would make the library a different
 * library every time it is read.
 */

const YOUTUBE_PREFIX = 'yt:';
const LOCAL_PREFIX = 'local:';

export function youtubeTrackId(videoId: string): string {
  const value = videoId.trim();
  if (!value) throw new Error('video id is required');
  return `${YOUTUBE_PREFIX}${value}`;
}

export async function localTrackId(canonicalPath: string): Promise<string> {
  const value = canonicalPath.trim();
  if (!value) throw new Error('canonical path is required');

  const bytes = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return `${LOCAL_PREFIX}${toHex(new Uint8Array(digest))}`;
}

export function isYouTubeTrackId(id: string): boolean {
  return id.startsWith(YOUTUBE_PREFIX) && id.length > YOUTUBE_PREFIX.length;
}

export function isLocalTrackId(id: string): boolean {
  return id.startsWith(LOCAL_PREFIX) && id.length > LOCAL_PREFIX.length;
}

export function videoIdFromTrackId(id: string): string {
  if (!isYouTubeTrackId(id)) throw new Error(`not a YouTube track id: ${id}`);
  return id.slice(YOUTUBE_PREFIX.length);
}

function toHex(bytes: Uint8Array): string {
  let out = '';
  for (const byte of bytes) out += byte.toString(16).padStart(2, '0');
  return out;
}