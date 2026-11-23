import { useEffect, useRef, useState } from 'react';
import type { AudioEngine } from '../../core/audio/AudioEngine';

/**
 * Probe the analyser for ~1.2 s after playback starts.
 *
 * The canvas visualizer is the real consumer; this exists to prove the samples are not
 * cross-origin-tainted. It runs in requestAnimationFrame, not in React's render loop,
 * and is cancelled when the probe key changes or the component unmounts.
 */
export function useAnalyserProbe(
  engine: AudioEngine,
  probeKey: string | null,
  onResult: (peak: number) => void,
): { peak: number } {
  const [peak, setPeak] = useState(0);
  const lastUiUpdate = useRef(0);

  useEffect(() => {
    if (!probeKey) return;

    let frame = 0;
    let maximum = 0;
    const started = performance.now();
    setPeak(0);

    const tick = () => {
      maximum = Math.max(maximum, engine.peak());
      const now = performance.now();
      if (now - lastUiUpdate.current > 100) {
        lastUiUpdate.current = now;
        setPeak(maximum);
      }

      if (now - started < 1200) {
        frame = requestAnimationFrame(tick);
      } else {
        frame = 0;
        setPeak(maximum);
        onResult(maximum);
      }
    };

    frame = requestAnimationFrame(tick);
    return () => {
      if (frame !== 0) cancelAnimationFrame(frame);
    };
  }, [engine, probeKey, onResult]);

  return { peak };
}