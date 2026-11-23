import type { RefObject } from 'react';
import { EQ_BANDS } from '../core/audio/AudioEngine';
import type { TrackSource } from '../core/library/types';
import { progressPercent, type ToolchainStatus } from '../core/platform/toolchain';
import type { PlayerState } from '../core/player/types';
import type { Check } from '../features/smoke/checks';

/**
 * Presentational smoke-test panels. No audio, no invoke(), no playback decisions: every
 * value arrives as a prop from the snapshot or from an App callback.
 */

export function ToolchainBanner({
  status,
  onRetry,
}: {
  status: ToolchainStatus | null;
  onRetry: () => void;
}) {
  if (!status || status.phase === 'ready') return null;

  return (
    <div className="bootstrap" data-phase={status.phase}>
      <span className="bootstrap-dot" />
      <div className="bootstrap-text">
        <strong>
          {status.phase === 'checking' && 'Checking yt-dlp…'}
          {status.phase === 'downloading' && 'Installing yt-dlp'}
          {status.phase === 'error' && 'yt-dlp unavailable'}
        </strong>
        {status.detail && <span>{status.detail}</span>}
      </div>
      {progressPercent(status) !== null && (
        <div className="bootstrap-progress">
          <div style={{ width: `${progressPercent(status)}%` }} />
        </div>
      )}
      {status.phase === 'error' && (
        <button className="ghost" onClick={onRetry}>
          Retry
        </button>
      )}
    </div>
  );
}

export function SourcePanel({
  url,
  onUrlChange,
  onResolve,
  onOpenLocal,
  onRecheck,
  busy,
  toolchainReady,
}: {
  url: string;
  onUrlChange: (value: string) => void;
  onResolve: () => void;
  onOpenLocal: () => void;
  onRecheck: () => void;
  busy: string | null;
  toolchainReady: boolean;
}) {
  return (
    <section className="panel">
      <h2>1 · Source</h2>
      <div className="row">
        <input
          value={url}
          onChange={(event) => onUrlChange(event.target.value)}
          placeholder="https://music.youtube.com/watch?v=…"
          spellCheck={false}
        />
        <button onClick={onResolve} disabled={busy !== null || !toolchainReady}>
          Resolve
        </button>
      </div>
      <div className="row">
        <button className="ghost" onClick={onOpenLocal} disabled={busy !== null}>
          Open local file…
        </button>
        <button className="ghost" onClick={onRecheck} disabled={busy !== null}>
          Recheck toolchain
        </button>
      </div>
      {busy && <p className="busy">{busy}</p>}
    </section>
  );
}

export function TransportPanel({
  title,
  source,
  state,
  positionSec,
  durationSec,
  hasTrack,
  onTogglePlay,
  onRestart,
  onSeekTest,
  onSeek,
}: {
  title: string;
  source: TrackSource | 'none';
  state: PlayerState;
  positionSec: number;
  durationSec: number;
  hasTrack: boolean;
  onTogglePlay: () => void;
  onRestart: () => void;
  onSeekTest: () => void;
  onSeek: (seconds: number) => void;
}) {
  const playing = state === 'playing';
  const maximum = Math.max(1, durationSec);

  return (
    <section className="panel">
      <h2>2 · Transport</h2>
      <div className="now">
        <span className="source-dot" data-kind={source} />
        <div>
          <div className="track-title">{title}</div>
          <div className="muted">
            {formatTime(positionSec)} / {formatTime(durationSec)} · {state}
          </div>
        </div>
      </div>
      <div className="row">
        <button className="primary" onClick={onTogglePlay} disabled={!hasTrack || state === 'loading'}>
          {playing ? 'Pause' : 'Play'}
        </button>
        <button className="ghost" onClick={onRestart} disabled={!hasTrack}>
          ⟲
        </button>
        <button className="ghost" onClick={onSeekTest} disabled={!hasTrack}>
          Seek → 80%
        </button>
      </div>
      <input
        className="scrub"
        type="range"
        min={0}
        max={maximum}
        step={0.1}
        value={Math.min(positionSec, maximum)}
        onChange={(event) => onSeek(Number(event.target.value))}
      />
    </section>
  );
}

export function EqPanel({
  gains,
  onChange,
}: {
  gains: number[];
  onChange: (index: number, db: number) => void;
}) {
  return (
    <section className="panel">
      <h2>3 · 10-band EQ</h2>
      <div className="eq">
        {EQ_BANDS.map((band, index) => (
          <div className="band" key={band}>
            <input
              className="slider"
              type="range"
              min={-12}
              max={12}
              step={0.5}
              value={gains[index] ?? 0}
              aria-label={`${band} Hz`}
              onChange={(event) => onChange(index, Number(event.target.value))}
            />
            <span>{band >= 1000 ? `${band / 1000}k` : band}</span>
          </div>
        ))}
      </div>
    </section>
  );
}

export function VisualizerPanel({
  canvasRef,
  peak,
}: {
  canvasRef: RefObject<HTMLCanvasElement | null>;
  peak: number;
}) {
  return (
    <section className="panel visual">
      <h2>4 · Visualizer</h2>
      <canvas ref={canvasRef} />
      <div className="meter">
        <span>analyser peak</span>
        <div className="bar">
          <div style={{ width: `${Math.min(1, peak * 3) * 100}%` }} />
        </div>
        <code>{peak.toFixed(3)}</code>
      </div>
    </section>
  );
}

export function ChecklistPanel({ checks }: { checks: Check[] }) {
  return (
    <section className="panel">
      <h2>5 · Checklist</h2>
      <ul className="checks">
        {checks.map((check) => (
          <li key={check.id} data-state={check.state}>
            <span className="dot" />
            <div>
              <div>{check.label}</div>
              {check.detail && <div className="detail">{check.detail}</div>}
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}

export function LogPanel({ log }: { log: string[] }) {
  return (
    <section className="panel log-panel">
      <h2>Log</h2>
      <pre>{log.join('\n') || 'waiting…'}</pre>
    </section>
  );
}

function formatTime(seconds: number): string {
  if (!Number.isFinite(seconds)) return '0:00';
  const minutes = Math.floor(seconds / 60);
  const rest = Math.floor(seconds % 60);
  return `${minutes}:${rest.toString().padStart(2, '0')}`;
}