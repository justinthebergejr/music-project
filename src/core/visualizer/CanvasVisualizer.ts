/**
 * Canvas 2D spectrum renderer.
 *
 * Runs entirely outside React: a rAF loop writing to a canvas it owns. React must
 * never re-render per frame, so the visualizer gets an analyser and a canvas and
 * nothing else.
 */

const MIN_HZ = 30;
const MAX_HZ = 16000;
const BAR_COUNT = 72;

export class CanvasVisualizer {
  private readonly ctx2d: CanvasRenderingContext2D;
  private readonly data: Uint8Array<ArrayBuffer>;
  private readonly resizeObserver: ResizeObserver;
  private raf = 0;
  private disposed = false;
  private accent = '#f25c3b';
  private width = 0;
  private height = 0;

  constructor(
    private readonly canvas: HTMLCanvasElement,
    private readonly analyser: AnalyserNode,
    private readonly context: AudioContext,
  ) {
    const ctx2d = canvas.getContext('2d');
    if (!ctx2d) throw new Error('canvas 2d context unavailable');
    this.ctx2d = ctx2d;
    this.data = new Uint8Array(analyser.frequencyBinCount);

    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(canvas);
    this.resize();
  }

  setAccent(color: string) {
    this.accent = color;
  }

  start() {
    if (this.raf || this.disposed) return;
    const loop = () => {
      if (this.disposed) return;
      this.draw();
      this.raf = requestAnimationFrame(loop);
    };
    this.raf = requestAnimationFrame(loop);
  }

  dispose() {
    this.disposed = true;
    if (this.raf) cancelAnimationFrame(this.raf);
    this.raf = 0;
    this.resizeObserver.disconnect();
  }

  private resize() {
    const dpr = window.devicePixelRatio || 1;
    const rect = this.canvas.getBoundingClientRect();
    this.width = Math.max(1, Math.floor(rect.width));
    this.height = Math.max(1, Math.floor(rect.height));
    this.canvas.width = Math.floor(this.width * dpr);
    this.canvas.height = Math.floor(this.height * dpr);
    this.ctx2d.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  private draw() {
    const { ctx2d, width, height } = this;
    if (width <= 0 || height <= 0) return;

    this.analyser.getByteFrequencyData(this.data);
    ctx2d.clearRect(0, 0, width, height);

    const gap = 3;
    const barWidth = Math.max(1, (width - gap * (BAR_COUNT - 1)) / BAR_COUNT);
    const nyquist = this.context.sampleRate / 2;
    const ratio = MAX_HZ / MIN_HZ;

    const gradient = ctx2d.createLinearGradient(0, height, 0, 0);
    gradient.addColorStop(0, this.accent);
    gradient.addColorStop(1, '#ffd8c9');

    ctx2d.fillStyle = gradient;
    ctx2d.globalAlpha = 0.92;

    for (let i = 0; i < BAR_COUNT; i += 1) {
      const t = i / (BAR_COUNT - 1);
      const hz = MIN_HZ * Math.pow(ratio, t);
      const bin = Math.min(this.data.length - 1, Math.floor((hz / nyquist) * this.data.length));
      // sqrt lifts quiet bins so the low end does not dominate the whole frame
      const level = Math.sqrt(this.data[bin] / 255);
      const barHeight = Math.max(2, level * height * 0.92);
      const x = i * (barWidth + gap);
      const y = height - barHeight;

      if (typeof ctx2d.roundRect === 'function') {
        ctx2d.beginPath();
        ctx2d.roundRect(x, y, barWidth, barHeight, Math.min(barWidth / 2, 4));
        ctx2d.fill();
      } else {
        ctx2d.fillRect(x, y, barWidth, barHeight);
      }
    }

    ctx2d.globalAlpha = 1;
  }
}
