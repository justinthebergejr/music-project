import { invoke } from '@tauri-apps/api/core';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';

export type ToolchainPhase = 'checking' | 'downloading' | 'ready' | 'error';

export type ToolchainStatus = {
  phase: ToolchainPhase;
  version: string | null;
  path: string | null;
  detail: string | null;
  received: number;
  total: number;
};

/** Install or update yt-dlp. Verified against the release checksum before use. */
export function ensureToolchain(force = false): Promise<ToolchainStatus> {
  return invoke<ToolchainStatus>('toolchain_ensure', { force });
}

export function readToolchainStatus(): Promise<ToolchainStatus> {
  return invoke<ToolchainStatus>('toolchain_status');
}

export function onToolchainStatus(handler: (status: ToolchainStatus) => void): Promise<UnlistenFn> {
  return listen<ToolchainStatus>('toolchain://status', (event) => handler(event.payload));
}

export function progressPercent(status: ToolchainStatus): number | null {
  if (status.phase !== 'downloading' || status.total <= 0) return null;
  return Math.min(100, Math.round((status.received / status.total) * 100));
}
