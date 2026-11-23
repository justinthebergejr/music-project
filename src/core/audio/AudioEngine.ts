/**
 * The single audio graph for the whole app.
 *
 * One AudioContext, one MediaElementAudioSourceNode per element, built once and
 * never rebuilt. Calling createMediaElementSource twice on the same element throws,
 * and a cross-origin media element that is connected here silently yields zeroes —
 * which is why every byte is served by the Rust loopback server with CORS headers.
 *
 * chain: <audio> -> source -> 10x biquad -> gain -> analyser -> destination
 */

export const EQ_BANDS = [32, 64, 125, 250, 500, 1000, 2000, 4000, 8000, 16000] as const;

export const EQ_Q = 1.1;

export class AudioEngine {
  readonly ctx: AudioContext;
  readonly analyser: AnalyserNode;

  private readonly filters: BiquadFilterNode[];
  private readonly gain: GainNode;
  private source: MediaElementAudioSourceNode | null = null;
  private readonly timeData: Uint8Array<ArrayBuffer>;

  constructor() {
    this.ctx = new AudioContext({ latencyHint: 'playback' });
    this.analyser = this.ctx.createAnalyser();
    this.analyser.fftSize = 2048;
    this.analyser.smoothingTimeConstant = 0.8;
    this.timeData = new Uint8Array(this.analyser.fftSize);

    this.filters = EQ_BANDS.map((frequency) => {
      const filter = this.ctx.createBiquadFilter();
      filter.type = 'peaking';
      filter.frequency.value = frequency;
      filter.Q.value = EQ_Q;
      filter.gain.value = 0;
      return filter;
    });

    this.gain = this.ctx.createGain();
    this.gain.gain.value = 1;

    for (let i = 0; i < this.filters.length - 1; i += 1) {
      this.filters[i].connect(this.filters[i + 1]);
    }
    this.filters[this.filters.length - 1].connect(this.gain);
    this.gain.connect(this.analyser);
    this.analyser.connect(this.ctx.destination);
  }

  /** Idempotent: the source is created exactly once per element. */
  attach(el: HTMLAudioElement) {
    if (this.source) return;
    el.crossOrigin = 'anonymous';
    this.source = this.ctx.createMediaElementSource(el);
    this.source.connect(this.filters[0]);
  }

  async resume() {
    if (this.ctx.state !== 'running') {
      await this.ctx.resume();
    }
  }

  setBandGain(index: number, db: number) {
    const filter = this.filters[index];
    if (filter) filter.gain.value = db;
  }

  setVolume(value: number) {
    this.gain.gain.value = Math.min(1, Math.max(0, value));
  }

  readFrequency(target: Uint8Array<ArrayBuffer>) {
    this.analyser.getByteFrequencyData(target);
  }

  /** Peak deviation from silence, 0..1. Zero means the analyser is seeing nothing. */
  peak(): number {
    this.analyser.getByteTimeDomainData(this.timeData);
    let max = 0;
    for (let i = 0; i < this.timeData.length; i += 1) {
      const deviation = Math.abs(this.timeData[i] - 128);
      if (deviation > max) max = deviation;
    }
    return max / 128;
  }
}

let singleton: AudioEngine | null = null;

/** Audio hardware and the graph outlive any one component tree. */
export function getAudioEngine(): AudioEngine {
  if (!singleton) singleton = new AudioEngine();
  return singleton;
}
