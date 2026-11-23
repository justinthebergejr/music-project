import { useCallback, useEffect, useRef, useState } from 'react';
import { open } from '@tauri-apps/plugin-dialog';
import './App.css';
import { EQ_BANDS, getAudioEngine } from './core/audio/AudioEngine';
import { CanvasVisualizer } from './core/visualizer/CanvasVisualizer';
import { importLocalTrack, resolveYouTubeTrack } from './core/platform/media';
import type { ToolchainStatus } from './core/platform/toolchain';
import { usePlayer } from './features/player/usePlayer';
import { useAnalyserProbe } from './features/smoke/useAnalyserProbe';
import { useToolchainStatus } from './features/smoke/useToolchainStatus';
import { INITIAL_CHECKS, type Check, type CheckState } from './features/smoke/checks';
import {
  ChecklistPanel,
  EqPanel,
  LogPanel,
  SourcePanel,
  ToolchainBanner,
  TransportPanel,
  VisualizerPanel,
} from './views/SmokePanels';

const TEST_URL = 'https://www.youtube.com/watch?v=dQw4w9WgXcQ';

export default function App() {
  const { controller: player, snapshot } = usePlayer();
  const engineRef = useRef(getAudioEngine());
  const engine = engineRef.current;
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const visualizerRef = useRef<CanvasVisualizer | null>(null);

  const [checks, setChecks] = useState<Check[]>(INITIAL_CHECKS);
  const [url, setUrl] = useState(TEST_URL);
  const [busy, setBusy] = useState<string | null>(null);
  const [eq, setEq] = useState<number[]>(() => EQ_BANDS.map(() => 0));
  const [log, setLog] = useState<string[]>([]);
  const [env, setEnv] = useState('');

  const note = useCallback((line: string) => {
    setLog((previous) => [`${new Date().toLocaleTimeString()}  ${line}`, ...previous].slice(0, 60));
  }, []);

  const setCheck = useCallback((id: string, state: CheckState, detail?: string) => {
    setChecks((previous) => previous.map((check) => (check.id === id ? { ...check, state, detail } : check)));
  }, []);

  // The controller owns the audio element; this component owns only the canvas.
  useEffect(() => {
    setCheck('graph', 'pass', `${engine.ctx.state} · ${engine.ctx.sampleRate} Hz`);
    setEnv(
      `${navigator.userAgent.includes('Mac') ? 'macOS/WKWebView' : 'Windows/WebView2'} · dpr ${window.devicePixelRatio.toFixed(2)}`,
    );

    const canvas = canvasRef.current;
    if (!canvas) return;
    const visualizer = new CanvasVisualizer(canvas, engine.analyser, engine.ctx);
    visualizer.start();
    visualizerRef.current = visualizer;

    return () => {
      visualizer.dispose();
      visualizerRef.current = null;
    };
  }, [engine, setCheck]);

  const applyToolchain = useCallback(
    (status: ToolchainStatus) => {
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

  const { status: toolchain, recheck } = useToolchainStatus(applyToolchain, note);

  const onAnalyserResult = useCallback(
    (peak: number) => {
      setCheck('analyser', peak > 0.005 ? 'pass' : 'fail', `peak ${peak.toFixed(3)}`);
      note(`analyser peak ${peak.toFixed(3)} (${peak > 0.005 ? 'live' : 'SILENT — check CORS'})`);
    },
    [note, setCheck],
  );

  const probeKey = snapshot.state === 'playing' ? (snapshot.track?.id ?? null) : null;
  const { peak } = useAnalyserProbe(engine, probeKey, onAnalyserResult);

  const resolveYouTube = useCallback(async () => {
    const target = url.trim();
    if (!target) return;
    setBusy('resolving with yt-dlp…');
    setCheck('resolve', 'todo');
    setCheck('yt', 'todo');

    try {
      const started = performance.now();
      const track = await resolveYouTubeTrack(target);
      const elapsed = Math.round(performance.now() - started);
      setCheck('resolve', 'pass', `cached in ${elapsed}ms · ${track.id.replace(/^yt:/, '')}`);
      note(`resolved "${track.title}" in ${elapsed}ms`);

      await player.playTrack(track);
      const error = player.getSnapshot().error;
      if (error && error.code !== 'aborted') {
        setCheck('yt', 'fail', error.message);
        note(`playback failed: ${error.message}`);
      } else {
        setCheck('yt', 'pass');
      }
    } catch (error) {
      setCheck('resolve', 'fail', String(error));
      note(`resolve failed: ${String(error)}`);
    } finally {
      setBusy(null);
    }
  }, [note, player, setCheck, url]);

  const openLocal = useCallback(async () => {
    setBusy('opening file…');
    try {
      const picked = await open({
        multiple: false,
        directory: false,
        filters: [{ name: 'Audio', extensions: ['m4a', 'mp3', 'flac', 'wav', 'ogg', 'opus', 'aac'] }],
      });
      if (typeof picked !== 'string') return;

      const track = await importLocalTrack(picked);
      await player.playTrack(track);
      const error = player.getSnapshot().error;
      if (error && error.code !== 'aborted') {
        setCheck('local', 'fail', error.message);
        note(`local playback failed: ${error.message}`);
      } else {
        setCheck('local', 'pass', track.title);
        note(`serving local file: ${track.title}`);
      }
    } catch (error) {
      setCheck('local', 'fail', String(error));
      note(`local file failed: ${String(error)}`);
    } finally {
      setBusy(null);
    }
  }, [note, player, setCheck]);

  const togglePlay = useCallback(() => {
    if (snapshot.state === 'playing') player.pause();
    else void player.play();
  }, [player, snapshot.state]);

  const seekTest = useCallback(async () => {
    if (!snapshot.track || snapshot.durationSec <= 0) {
      setCheck('seek', 'fail', 'load a track first');
      return;
    }

    await engine.resume();
    const target = snapshot.durationSec * 0.8;
    const started = performance.now();
    player.seek(target);

    const reached = await new Promise<boolean>((resolve) => {
      const finish = (value: boolean) => {
        window.clearTimeout(timer);
        unsubscribe();
        resolve(value);
      };
      const unsubscribe = player.subscribe(() => {
        if (Math.abs(player.getSnapshot().positionSec - target) < 0.75) finish(true);
      });
      const timer = window.setTimeout(() => finish(false), 2000);
    });

    const elapsed = Math.round(performance.now() - started);
    setCheck('seek', reached && elapsed < 500 ? 'pass' : 'fail', `${elapsed}ms to 80%`);
    note(`seek to 80% took ${elapsed}ms${elapsed >= 500 ? ' — release-build protocol problem?' : ''}`);
  }, [engine, note, player, setCheck, snapshot.durationSec, snapshot.track]);

  const updateBand = useCallback(
    (index: number, db: number) => {
      engine.setBandGain(index, db);
      setEq((previous) => previous.map((value, i) => (i === index ? db : value)));
    },
    [engine],
  );

  return (
    <div className="shell">
      <header className="topbar">
        <div className="logo">M</div>
        <div className="titles">
          <h1>Malice</h1>
          <span className="tag">day 2 · player</span>
        </div>
        <div className="env">
          {env}
          {toolchain?.phase === 'ready' && toolchain.version ? ` · yt-dlp ${toolchain.version}` : ''}
        </div>
      </header>

      <ToolchainBanner status={toolchain} onRetry={recheck} />

      <main className="layout">
        <div className="column">
          <SourcePanel
            url={url}
            onUrlChange={setUrl}
            onResolve={resolveYouTube}
            onOpenLocal={openLocal}
            onRecheck={recheck}
            busy={busy}
            toolchainReady={toolchain?.phase === 'ready'}
          />
          <TransportPanel
            title={snapshot.track?.title ?? 'nothing loaded'}
            source={snapshot.track?.source ?? 'none'}
            state={snapshot.state}
            positionSec={snapshot.positionSec}
            durationSec={snapshot.durationSec}
            hasTrack={snapshot.track !== null}
            onTogglePlay={togglePlay}
            onRestart={() => player.seek(0)}
            onSeekTest={() => void seekTest()}
            onSeek={(seconds) => player.seek(seconds)}
          />
          <EqPanel gains={eq} onChange={updateBand} />
        </div>

        <div className="column">
          <VisualizerPanel canvasRef={canvasRef} peak={peak} />
          <ChecklistPanel checks={checks} />
          <LogPanel log={log} />
        </div>
      </main>
    </div>
  );
}