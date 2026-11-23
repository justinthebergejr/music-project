import { invoke } from '@tauri-apps/api/core';
import { appDataDir, join } from '@tauri-apps/api/path';
import type { LibraryIO } from '../library/types';

/**
 * The only place the library touches the native side.
 *
 * The path is derived from Tauri's app-data directory (never hardcoded). Rust validates
 * that the value is `library.json` directly inside that directory before reading,
 * writing, or backing it up.
 */
export async function libraryFilePath(): Promise<string> {
  return join(await appDataDir(), 'library.json');
}

export const libraryIO: LibraryIO = {
  async read(): Promise<string | null> {
    const path = await libraryFilePath();
    return invoke<string | null>('library_read', { path });
  },

  async writeAtomic(contents: string): Promise<void> {
    const path = await libraryFilePath();
    await invoke('library_write', { path, contents });
  },

  async backup(): Promise<void> {
    const path = await libraryFilePath();
    await invoke('library_backup', { path });
  },
};