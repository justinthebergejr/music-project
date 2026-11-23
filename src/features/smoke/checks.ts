export type CheckState = 'todo' | 'pass' | 'fail';

export interface Check {
  id: string;
  label: string;
  state: CheckState;
  detail?: string;
}

export const INITIAL_CHECKS: Check[] = [
  { id: 'graph', label: 'Audio graph built (1 context, 10 bands)', state: 'todo' },
  { id: 'toolchain', label: 'yt-dlp installed, verified, and runnable', state: 'todo' },
  { id: 'analyser', label: 'Analyser sees real samples (peak > 0)', state: 'todo' },
  { id: 'local', label: 'Local file plays through the loopback server', state: 'todo' },
  { id: 'resolve', label: 'yt-dlp resolves a YouTube track', state: 'todo' },
  { id: 'yt', label: 'YouTube playback through the same graph', state: 'todo' },
  { id: 'seek', label: 'Seek to 80% under 500ms', state: 'todo' },
];