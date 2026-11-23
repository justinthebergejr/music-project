import { invoke } from '@tauri-apps/api/core';
import { retainResolvedSources } from './media';

/** One visible place for the policy; Rust receives the value instead of hardcoding it. */
export const DEFAULT_CACHE_CAP_BYTES = 500 * 1024 * 1024;

export interface CacheStats {
  bytes: number;
  files: number;
  capBytes: number;
}

export function cacheStats(capBytes: number = DEFAULT_CACHE_CAP_BYTES): Promise<CacheStats> {
  return invoke<CacheStats>('cache_stats', { capBytes });
}

/**
 * Evict oldest cached media until under the cap, protecting `keepPaths`.
 *
 * After the walk, drop resolved-source URLs that were not protected: their files may
 * have been deleted, and a stale id would 404. The currently playing track's path is in
 * `keepPaths`, so its URL survives for pause/resume and seeking.
 */
export async function cacheEvict(capBytes: number, keepPaths: string[]): Promise<CacheStats> {
  const stats = await invoke<CacheStats>('cache_evict', { capBytes, keepPaths });
  retainResolvedSources(keepPaths);
  return stats;
}