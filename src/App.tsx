import { useCallback, useEffect, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { open } from '@tauri-apps/plugin-dialog';
import './App.css';
import { EQ_BANDS, getAudioEngine } from './core/audio/AudioEngine';
import { CanvasVisualizer } from './core/visualizer/CanvasVisualizer';
import {
  ensureToolchain,
  onToolchainStatus,
  progressPercent,
  type ToolchainStatus,
} from './core/platform/toolchain';

type ResolvedTrack = { url: string; title: string; duration: number; video_id: string };

type CheckState = 'todo' | 'pass' | 'fail';
type Check = { id: string; label: string; state: CheckState; detail?: string };

const INITIAL_CHECKS: Check[] = [
  { id: 'graph', label: 'Audio graph built (1 context, 10 bands)', state: 'todo' },
  { id: 'toolchain', label: 'yt-dlp installed, verified, and runnable', state: 'todo' },
  { id: 'analyser', label: 'Analyser sees real samples (peak > 0)', state: 'todo' },
  { id: 'local', label: 'Local file plays through the loopback server', state: 'todo' },
  { id: 'resolve', label: 'yt-dlp resolves a YouTube track', state: 'todo' },
  { id: 'yt', label: 'YouTube playback through the same graph', state: 'todo' },
  { id: 'seek', label: 'Seek to 80% under 500ms', state: 'todo' },
];

const TEST_URL = 'https://www.youtube.com/watch?v=dQw4w9WgXcQ';

/**
 * Load media as an in-memory Blob instead of a loopback HTTP stream.
 *
 * Set to false to fall back to the plain HTTP source (one-line revert if a platform
 * ever refuses to feed Blob media into Web Audio).
 */
const USE_BLOB_SOURCE = true;

function formatTime(seconds: number) {
  if (!Number.isFinite(seconds)) return '0:00';
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${s.toString().padStart(2, '0')}`;
}

export default function App() {
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const visualizerRef = useRef<CanvasVisualizer | null>(null);
  const engineRef = useRef(getAudioEngine());
  const sampledRef = useRef<string | null>(null);

  const [checks, setChecks] = useState<Check[]>(INITIAL_CHECKS);
  const [url, setUrl] = useState(TEST_URL);
  const [title, setTitle] = useState('nothing loaded');
  const [source, setSource] = useState<'none' | 'local' | 'youtube'>('none');
  const [duration, setDuration] = useState(0);
  const [elementDuration, setElementDuration] = useState(0);
  const [currentTime, setCurrentTime] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [log, setLog] = useState<string[]>([]);
  const [eq, setEq] = useState<number[]>(() => EQ_BANDS.map(() => 0));
  const [peak, setPeak] = useState(0);
  const [env, setEnv] = useState('');
  const [toolchain, setToolchain] = useState<ToolchainStatus | null>(null);

  const engine = engineRef.current;
  const knownDurationRef = useRef(0);
  const objectUrlRef = useRef<string | null>(null);

  const note = useCallback((line: string) => {
    setLog((prev) => [`${new Date().toLocaleTimeString()}  ${line}`, ...prev].slice(0, 60));
  }, []);

  const setCheck = useCallback((id: string, state: CheckState, detail?: string) => {
    setChecks((prev) => prev.map((c) => (c.id === id ? { ...c, state, detail: detail ?? c.detail } : c)));
  }, []);

  const applyToolchain = useCallback(
    (status: ToolchainStatus) => {
      setToolchain(status);
      if (status.phase === 'ready' && status.version) {
        setCheck('toolchain', 'pass', `yt-dlp ${status.version}`);
      } else if (status.phase === 'error') {
        setCheck('toolchain', 'fail', status.detail ?? 'toolchain unavailable');
      } else {
        setCheck('toolchain', 'todo', status.detail ?? undefined);
      }
    },
    [setCheck],
  );

  /**
   * The element's duration is advisory, not authoritative.
   *
   * YouTube's DASH audio arrives as a fragmented MP4 (moov + sidx + many moof/mdat
   * pairs). WebKit's incremental fMP4 path miscomputes that duration — 2x on the first
   * track tested — while the file on disk is correct (afinfo agrees with ffprobe).
   * Metadata from the resolver is exact, so it wins when the two disagree.
   */
  const pickDuration = useCallback(
    (raw: number) => {
      const known = knownDurationRef.current;
      if (!Number.isFinite(raw) || raw <= 0) return known;
      if (known <= 0) return raw;
      const ratio = raw / known;
      if (ratio > 1.05 || ratio < 0.95) {
        note(
          `duration mismatch: element ${raw.toFixed(1)}s vs metadata ${known.toFixed(1)}s — using metadata`,
        );
        return known;
      }
      return raw;
    },
    [note],
  );

  /**
   * Hand the element a complete resource rather than a byte stream.
   *
   * Every track is already fully on disk (cache-then-play), so loading it as a Blob is
   * free in latency terms and sidesteps the fragmented-MP4 streaming quirks above.
   * Large local files stay on the HTTP path to avoid holding hundreds of MB in memory.
   */
  const prepareSource = useCallback(
    async (url: string, knownSize: number) => {
      if (!USE_BLOB_SOURCE) return url;
      const maxBlobBytes = 64 * 1024 * 1024;
      if (knownSize > maxBlobBytes) return url;
      try {
        const response = await fetch(url);
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const declared = Number(response.headers.get('content-length') ?? 0);
        if (declared > maxBlobBytes) return url;
        const blob = await response.blob();
        if (blob.size > maxBlobBytes) return url;
        if (objectUrlRef.current) URL.revokeObjectURL(objectUrlRef.current);
        const objectUrl = URL.createObjectURL(blob);
        objectUrlRef.current = objectUrl;
        return objectUrl;
      } catch (err) {
        note(`blob load failed, using direct source: ${String(err)}`);
        return url;
      }
    },
    [note],
  );

  useEffect(() => {
    const audio = audioRef.current;
    const canvas = canvasRef.current;
    if (!audio || !canvas) return;

    engine.attach(audio);
    setCheck('graph', 'pass', `${engine.ctx.state} · ${engine.ctx.sampleRate} Hz`);
    setEnv(
      `${navigator.userAgent.includes('Mac') ? 'macOS/WKWebView' : 'Windows/WebView2'} · dpr ${window.devicePixelRatio.toFixed(2)}`,
    );

    const visualizer = new CanvasVisualizer(canvas, engine.analyser, engine.ctx);
    visualizer.start();
    visualizerRef.current = visualizer;

    return () => {
      visualizer.dispose();
      visualizerRef.current = null;
    };
  }, [engine, setCheck]);

  // Launch-time bootstrap: on a fresh machine the binary is missing, and a GUI launch
  // does not inherit the shell PATH. Rust installs it, verifies the checksum, and
  // reports progress on an event so this never blocks the UI thread.
  useEffect(() => {
    let unlisten: (() => void) | null = null;
    let cancelled = false;

    const handle = (status: ToolchainStatus) => {
      if (!cancelled) applyToolchain(status);
    };

    void (async () => {
      // Progress events are a nicety; the returned status is authoritative. A failed
      // subscription must not prevent the install from running.
      try {
        unlisten = await onToolchainStatus(handle);
      } catch (err) {
        note(`toolchain events unavailable: ${String(err)}`);
      }
      try {
        handle(await ensureToolchain(false));
      } catch (err) {
        handle({
          phase: 'error',
          version: null,
          path: null,
          detail: String(err),
          received: 0,
          total: 0,
        });
      }
    })();

    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, [applyToolchain, note]);

  useEffect(() => {
    const audio = audioRef.current;
    if (!audio) return;

    const onTime = () => setCurrentTime(audio.currentTime);    const onMeta = () => {
      const raw = audio.duration;
      setElementDuration(Number.isFinite(raw) ? raw : 0);
      setDuration(pickDuration(raw));
    };
    const onPlay = () => setPlaying(true);
    const onPause = () => setPlaying(false);
    const onError = () => {
      const code = audio.error?.code ?? -1;
      note(`audio element error (code ${code})`);
      setBusy(null);
    };

    audio.addEventListener('timeupdate', onTime);
    audio.addEventListener('loadedmetadata', onMeta);
    audio.addEventListener('play', onPlay);
    audio.addEventListener('pause', onPause);
    audio.addEventListener('error', onError);

    return () => {
      audio.removeEventListener('timeupdate', onTime);
      audio.removeEventListener('loadedmetadata', onMeta);
      audio.removeEventListener('play', onPlay);
      audio.removeEventListener('pause', onPause);
      audio.removeEventListener('error', onError);
    };
  }, [note]);

  // Sample the analyser for ~1.2s after playback starts. Zeroes mean the media is
  // cross-origin-tainted, and no amount of visualizer tuning will fix it.
  const sampleAnalyser = useCallback(() => {
    let max = 0;
    const started = performance.now();
    const tick = () => {
      max = Math.max(max, engine.peak());
      setPeak(max);
      if (performance.now() - started < 1200) {
        requestAnimationFrame(tick);
      } else {
        setCheck('analyser', max > 0.005 ? 'pass' : 'fail', `peak ${max.toFixed(3)}`);
        note(`analyser peak ${max.toFixed(3)} (${max > 0.005 ? 'live' : 'SILENT — check CORS'})`);
      }
    };
    requestAnimationFrame(tick);
  }, [engine, note, setCheck]);

  useEffect(() => {
    const audio = audioRef.current;
    if (!audio) return;
    const onPlaying = () => {
      const key = audio.currentSrc || audio.src;
      if (sampledRef.current === key) return;
      sampledRef.current = key;
      sampleAnalyser();
    };
    audio.addEventListener('playing', onPlaying);
    return () => audio.removeEventListener('playing', onPlaying);
  }, [sampleAnalyser]);

  const load = useCallback(
    async (nextUrl: string, nextTitle: string, kind: 'local' | 'youtube', knownDuration = 0) => {
      const audio = audioRef.current;
      if (!audio) return;
      sampledRef.current = null;
      knownDurationRef.current = knownDuration;
      setSource(kind);
      setTitle(nextTitle);
      setElementDuration(0);
      setDuration(knownDuration);
      setCurrentTime(0);
      setPlaying(false);

      const source = await prepareSource(nextUrl, 0);
      audio.src = source;
      audio.load();
      await engine.resume();
      try {
        await audio.play();
      } catch (err) {
        note(`play() rejected: ${String(err)}`);
        setBusy(null);
      }
    },
    [engine, note, prepareSource],
  );

  const resolveYouTube = useCallback(async () => {
    const target = url.trim();
    if (!target) return;
    setBusy('resolving with yt-dlp…');
    setCheck('resolve', 'todo');
    setCheck('yt', 'todo');
    try {
      const started = performance.now();
      const result = await invoke<ResolvedTrack>('resolve_track', { url: target });
      const ms = Math.round(performance.now() - started);
      setCheck('resolve', 'pass', `cached in ${ms}ms · ${result.video_id}`);
      note(`resolved "${result.title}" in ${ms}ms`);
      await load(result.url, result.title, 'youtube', result.duration);
      setCheck('yt', 'pass');
    } catch (err) {
      setCheck('resolve', 'fail', String(err));
      note(`resolve failed: ${String(err)}`);
    } finally {
      setBusy(null);
    }
  }, [load, note, setCheck, url]);

  const openLocal = useCallback(async () => {
    setBusy('opening file…');
    try {
      const picked = await open({
        multiple: false,
        directory: false,
        filters: [{ name: 'Audio', extensions: ['m4a', 'mp3', 'flac', 'wav', 'ogg', 'opus', 'aac'] }],
      });
      if (typeof picked !== 'string') return;
      const mediaUrl = await invoke<string>('register_local_file', { path: picked });
      const name = picked.split(/[\\/]/).pop() ?? 'local file';
      await load(mediaUrl, name, 'local');
      setCheck('local', 'pass', name);
      note(`serving local file: ${name}`);
    } catch (err) {
      setCheck('local', 'fail', String(err));
      note(`local file failed: ${String(err)}`);
    } finally {
      setBusy(null);
    }
  }, [load, note, setCheck]);

  const togglePlay = useCallback(async () => {
    const audio = audioRef.current;
    if (!audio || !audio.src) return;
    if (audio.paused) {
      await engine.resume();
      await audio.play().catch((err) => note(`play() rejected: ${String(err)}`));
    } else {
      audio.pause();
    }
  }, [engine, note]);

  const seekTo = useCallback((fraction: number) => {
    const audio = audioRef.current;
    if (!audio || !Number.isFinite(duration) || duration <= 0) return;
    audio.currentTime = duration * fraction;
  }, [duration]);

  const seekTest = useCallback(async () => {
    const audio = audioRef.current;
    if (!audio || !Number.isFinite(duration) || duration === 0) {
      setCheck('seek', 'fail', 'load a track first');
      return;
    }
    await engine.resume();
    const started = performance.now();
    await new Promise<void>((resolve) => {
      const onSeeked = () => {
        audio.removeEventListener('seeked', onSeeked);
        resolve();
      };
      audio.addEventListener('seeked', onSeeked);
      audio.currentTime = duration * 0.8;
      setTimeout(resolve, 2000);
    });
    const ms = Math.round(performance.now() - started);
    setCheck('seek', ms < 500 ? 'pass' : 'fail', `${ms}ms to 80%`);
    note(`seek to 80% took ${ms}ms${ms >= 500 ? ' — release-build protocol problem?' : ''}`);
  }, [duration, engine, note, setCheck]);

  const updateBand = useCallback(
    (index: number, db: number) => {
      engine.setBandGain(index, db);
      setEq((prev) => prev.map((v, i) => (i === index ? db : v)));
    },
    [engine],
  );

  // Blob URLs are process-wide references; release the last one on unmount.
  useEffect(
    () => () => {
      if (objectUrlRef.current) URL.revokeObjectURL(objectUrlRef.current);
    },
    [],
  );

  return (
    <div className="shell">
      <header className="topbar">
        <div className="logo">M</div>
        <div className="titles">
          <h1>Malice</h1>
          <span className="tag">day 1 smoke test</span>
        </div>
        <div className="env">
          {env}
          {toolchain?.phase === 'ready' && toolchain.version ? ` · yt-dlp ${toolchain.version}` : ''}
        </div>
      </header>

      {toolchain && toolchain.phase !== 'ready' && (
        <div className="bootstrap" data-phase={toolchain.phase}>
          <span className="bootstrap-dot" />
          <div className="bootstrap-text">
            <strong>
              {toolchain.phase === 'checking' && 'Checking yt-dlp…'}
              {toolchain.phase === 'downloading' && 'Installing yt-dlp'}
              {toolchain.phase === 'error' && 'yt-dlp unavailable'}
            </strong>
            {toolchain.detail && <span>{toolchain.detail}</span>}
          </div>
          {progressPercent(toolchain) !== null && (
            <div className="bootstrap-progress">
              <div style={{ width: `${progressPercent(toolchain)}%` }} />
            </div>
          )}
          {toolchain.phase === 'error' && (
            <button className="ghost" onClick={() => void ensureToolchain(true).then(applyToolchain)}>
              Retry
            </button>
          )}
        </div>
      )}

      <main className="layout">
        <div className="column">
          <section className="panel">
            <h2>1 · Source</h2>
            <div className="row">
              <input
                value={url}
                onChange={(e) => setUrl(e.target.value)}
                placeholder="https://music.youtube.com/watch?v=…"
                spellCheck={false}
              />
              <button onClick={resolveYouTube} disabled={busy !== null || toolchain?.phase !== 'ready'}>
                Resolve
              </button>
            </div>
            <div className="row">
              <button className="ghost" onClick={openLocal} disabled={busy !== null}>
                Open local file…
              </button>
              <button
                className="ghost"
                onClick={() => void ensureToolchain(true).then(applyToolchain)}
                disabled={busy !== null}
              >
                Recheck toolchain
              </button>
            </div>
            {busy && <p className="busy">{busy}</p>}
          </section>

          <section className="panel">
            <h2>2 · Transport</h2>
            <div className="now">
              <span className="source-dot" data-kind={source} />
              <div>
                <div className="track-title">{title}</div>
                <div className="muted">
                  {formatTime(currentTime)} / {formatTime(duration)}
                  {elementDuration > 0 && Math.abs(elementDuration - duration) > duration * 0.05 && (
                    <span className="diag"> · element reports {formatTime(elementDuration)}</span>
                  )}
                </div>
              </div>
            </div>
            <div className="row">
              <button className="primary" onClick={togglePlay}>
                {playing ? 'Pause' : 'Play'}
              </button>
              <button className="ghost" onClick={() => seekTo(0)}>
                ⟲
              </button>
              <button className="ghost" onClick={seekTest}>
                Seek → 80%
              </button>
            </div>
            <input
              className="scrub"
              type="range"
              min={0}
              max={Math.max(1, duration)}
              step={0.1}
              value={Math.min(currentTime, duration || 1)}
              onChange={(e) => {
                const audio = audioRef.current;
                if (audio) audio.currentTime = Number(e.target.value);
              }}
            />
          </section>

          <section className="panel">
            <h2>3 · 10-band EQ</h2>
            <div className="eq">
              {EQ_BANDS.map((band, i) => (
                <div className="band" key={band}>
                  <input
                    className="slider"
                    type="range"
                    min={-12}
                    max={12}
                    step={0.5}
                    value={eq[i]}
                    aria-label={`${band} Hz`}
                    onChange={(e) => updateBand(i, Number(e.target.value))}
                  />
                  <span>{band >= 1000 ? `${band / 1000}k` : band}</span>
                </div>
              ))}
            </div>
          </section>
        </div>

        <div className="column">
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

          <section className="panel">
            <h2>5 · Checklist</h2>
            <ul className="checks">
              {checks.map((c) => (
                <li key={c.id} data-state={c.state}>
                  <span className="dot" />
                  <div>
                    <div>{c.label}</div>
                    {c.detail && <div className="detail">{c.detail}</div>}
                  </div>
                </li>
              ))}
            </ul>
          </section>

          <section className="panel log-panel">
            <h2>Log</h2>
            <pre>{log.join('\n') || 'waiting…'}</pre>
          </section>
        </div>
      </main>

      <audio ref={audioRef} crossOrigin="anonymous" preload="auto" />
    </div>
  );
}
