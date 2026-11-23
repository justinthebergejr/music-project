import type { Track } from '../library/types';
import type {
  PlayerControllerOptions,
  PlayerError,
  PlayerErrorCode,
  PlayerSnapshot,
  PlayerState,
  RepeatMode,
} from './types';

export type {
  PlayerControllerOptions,
  PlayerError,
  PlayerErrorCode,
  PlayerSnapshot,
  PlayerState,
  RepeatMode,
} from './types';

/** WebKit mis-parses fragmented MP4 when it is streamed; a complete Blob avoids that. */
const MAX_BLOB_BYTES = 64 * 1024 * 1024;

const DURATION_TOLERANCE = 0.05;

interface PreparedSource {
  src: string;
  objectUrl: string | null;
}

/**
 * Own the one audio element and every playback decision.
 *
 * Plain TypeScript on purpose: React subscribes to the snapshot with
 * `useSyncExternalStore` and never creates or touches an audio element.
 */
export class PlayerController {
  private readonly engine: PlayerControllerOptions['engine'];
  private readonly resolveSource: PlayerControllerOptions['resolveSource'];
  private readonly element: HTMLAudioElement;
  private readonly listeners = new Set<() => void>();

  private state: PlayerState = 'idle';
  private current: Track | null = null;
  private queue: Track[] = [];
  private index = -1;
  private shuffleOn = false;
  private repeatMode: RepeatMode = 'off';
  private position = 0;
  private duration = 0;
  private error: PlayerError | null = null;

  private snapshot: PlayerSnapshot;
  private token = 0;
  private disposed = false;
  private objectUrl: string | null = null;
  private preparation: AbortController | null = null;
  private lastLoggedElementDuration = 0;

  constructor(options: PlayerControllerOptions) {
    this.engine = options.engine;
    this.resolveSource = options.resolveSource;
    this.element = new Audio();
    this.element.crossOrigin = 'anonymous';
    this.element.preload = 'auto';

    // Exactly once, in the constructor. A second attach on another element would throw
    // (createMediaElementSource is once per element) and leave that element silent.
    this.engine.attach(this.element);
    this.bindElement();

    this.snapshot = this.buildSnapshot();
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  getSnapshot = (): PlayerSnapshot => this.snapshot;

  async playTrack(track: Track, queue?: Track[]): Promise<void> {
    if (this.disposed) return;

    const token = ++this.token;
    this.abortPreparation();
    const preparation = new AbortController();
    this.preparation = preparation;

    // Stop the previous track while the new one resolves, so track switching never
    // leaves the old audio playing underneath a "loading" state.
    this.element.pause();

    // Starts inside the caller's user gesture. Awaiting resolveSource first would lose
    // the gesture for a YouTube track that takes a second or two to resolve.
    const resumed = this.engine.resume();
    // If a resolver/error path returns before we await this, do not leak a rejection.
    resumed.catch(() => undefined);

    this.replaceQueue(track, queue);
    this.current = track;
    this.state = 'loading';
    this.position = 0;
    this.duration = track.durationSec > 0 ? track.durationSec : 0;
    this.error = null;
    this.lastLoggedElementDuration = 0;
    this.emit();

    let resolvedUrl: string;
    try {
      resolvedUrl = await this.resolveSource(track);
    } catch (error) {
      if (!this.isCurrent(token)) return this.reportAborted(token);
      this.fail('resolve', describe(error));
      return;
    }
    if (!this.isCurrent(token)) return this.reportAborted(token);

    let prepared: PreparedSource;
    try {
      prepared = await this.prepareSource(resolvedUrl, preparation.signal);
    } catch (error) {
      if (!this.isCurrent(token) || preparation.signal.aborted) return this.reportAborted(token);
      this.fail('resolve', describe(error));
      return;
    }
    if (!this.isCurrent(token)) {
      if (prepared.objectUrl) URL.revokeObjectURL(prepared.objectUrl);
      return this.reportAborted(token);
    }

    try {
      await resumed;
    } catch (error) {
      if (!this.isCurrent(token)) {
        if (prepared.objectUrl) URL.revokeObjectURL(prepared.objectUrl);
        return this.reportAborted(token);
      }
      this.fail('unknown', `audio context could not start: ${describe(error)}`);
      return;
    }
    if (!this.isCurrent(token)) {
      if (prepared.objectUrl) URL.revokeObjectURL(prepared.objectUrl);
      return this.reportAborted(token);
    }

    this.attachSource(prepared.src, prepared.objectUrl);
    try {
      await this.element.play();
    } catch (error) {
      if (!this.isCurrent(token)) return;
      this.fail(isAbortError(error) ? 'aborted' : 'unknown', describe(error));
    }
  }

  async play(): Promise<void> {
    if (this.disposed || !this.current || this.state === 'loading') return;
    try {
      await this.engine.resume();
      if (this.state === 'ended' || this.element.ended) {
        this.element.currentTime = 0;
        this.position = 0;
      }
      await this.element.play();
    } catch (error) {
      this.fail(isAbortError(error) ? 'aborted' : 'unknown', describe(error));
    }
  }

  pause(): void {
    if (this.disposed || !this.current) return;
    this.element.pause();
    if (this.state === 'playing' || this.state === 'loading') {
      this.state = 'paused';
      this.position = this.element.currentTime;
      this.emit();
    }
  }

  async next(): Promise<void> {
    if (this.disposed || this.queue.length === 0) return;
    const nextIndex = this.pickNextIndex();
    if (nextIndex === null) {
      this.state = 'ended';
      this.emit();
      return;
    }
    await this.playTrack(this.queue[nextIndex], this.queue);
  }

  async previous(): Promise<void> {
    if (this.disposed || this.queue.length === 0) return;

    if (this.shuffleOn && this.queue.length > 1) {
      await this.playTrack(this.queue[randomOtherIndex(this.index, this.queue.length)], this.queue);
      return;
    }

    const candidate = this.index - 1;
    if (candidate >= 0) {
      await this.playTrack(this.queue[candidate], this.queue);
      return;
    }
    if (this.repeatMode === 'all' && this.queue.length > 1) {
      await this.playTrack(this.queue[this.queue.length - 1], this.queue);
      return;
    }

    // At the start: restart the current track rather than doing nothing.
    this.seek(0);
  }

  seek(sec: number): void {
    if (this.disposed || !this.current || !Number.isFinite(sec)) return;
    const elementDuration = Number.isFinite(this.element.duration) ? this.element.duration : 0;
    const maximum = this.duration > 0 ? this.duration : elementDuration;
    const target = maximum > 0 ? Math.min(Math.max(0, sec), maximum) : Math.max(0, sec);
    // Position is intentionally not emitted here: the element's `seeked`/`timeupdate`
    // event is the evidence that the seek actually happened.
    this.element.currentTime = target;
  }

  setVolume(value: number): void {
    const clamped = Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : 1;
    this.engine.setVolume(clamped);
  }

  setShuffle(on: boolean): void {
    if (this.shuffleOn === on) return;
    this.shuffleOn = on;
    this.emit();
  }

  setRepeat(mode: RepeatMode): void {
    if (this.repeatMode === mode) return;
    this.repeatMode = mode;
    this.emit();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.token += 1;
    this.abortPreparation();
    this.unbindElement();

    try {
      this.element.pause();
    } catch {
      // A detached element can reject pause() in some engines; teardown is best effort.
    }
    this.element.removeAttribute('src');
    this.element.load();

    if (this.objectUrl) {
      URL.revokeObjectURL(this.objectUrl);
      this.objectUrl = null;
    }

    this.listeners.clear();
    this.current = null;
    this.queue = [];
    this.index = -1;
    this.position = 0;
    this.duration = 0;
    this.error = null;
    this.state = 'idle';
    this.snapshot = this.buildSnapshot();
  }

  private bindElement(): void {
    this.element.addEventListener('play', this.onPlay);
    this.element.addEventListener('pause', this.onPause);
    this.element.addEventListener('timeupdate', this.onTimeUpdate);
    this.element.addEventListener('seeked', this.onSeeked);
    this.element.addEventListener('loadedmetadata', this.onLoadedMetadata);
    this.element.addEventListener('durationchange', this.onDurationChange);
    this.element.addEventListener('ended', this.onEnded);
    this.element.addEventListener('error', this.onError);
  }

  private unbindElement(): void {
    this.element.removeEventListener('play', this.onPlay);
    this.element.removeEventListener('pause', this.onPause);
    this.element.removeEventListener('timeupdate', this.onTimeUpdate);
    this.element.removeEventListener('seeked', this.onSeeked);
    this.element.removeEventListener('loadedmetadata', this.onLoadedMetadata);
    this.element.removeEventListener('durationchange', this.onDurationChange);
    this.element.removeEventListener('ended', this.onEnded);
    this.element.removeEventListener('error', this.onError);
  }

  private readonly onPlay = (): void => {
    if (this.disposed) return;
    this.state = 'playing';
    this.error = null;
    this.position = this.element.currentTime;
    this.refreshDuration();
    this.emit();
  };

  private readonly onPause = (): void => {
    if (this.disposed) return;
    if (this.state === 'ended' || this.state === 'idle') return;
    this.state = 'paused';
    this.position = this.element.currentTime;
    this.emit();
  };

  private readonly onTimeUpdate = (): void => {
    if (this.disposed) return;
    this.position = this.element.currentTime;
    if (this.duration === 0) this.refreshDuration();
    this.emit();
  };

  private readonly onSeeked = (): void => {
    if (this.disposed) return;
    this.position = this.element.currentTime;
    this.emit();
  };

  private readonly onLoadedMetadata = (): void => {
    if (this.disposed) return;
    this.refreshDuration();
    this.emit();
  };

  private readonly onDurationChange = (): void => {
    if (this.disposed) return;
    this.refreshDuration();
    this.emit();
  };

  private readonly onEnded = (): void => {
    if (this.disposed) return;
    this.state = 'ended';
    this.position = this.duration > 0 ? this.duration : this.element.currentTime;
    this.emit();

    if (this.repeatMode === 'one') {
      void this.replayCurrent();
      return;
    }
    if (this.repeatMode === 'all' || this.index < this.queue.length - 1) {
      void this.next();
    }
  };

  private readonly onError = (): void => {
    if (this.disposed) return;
    const mediaError = this.element.error;
    const code: PlayerErrorCode =
      mediaError?.code === 1 ? 'aborted' : mediaError?.code === 3 ? 'decode' : 'unknown';
    const detail = mediaError?.message || (mediaError ? `audio error ${mediaError.code}` : 'audio element failed');
    this.fail(code, detail);
  };

  private async replayCurrent(): Promise<void> {
    if (this.disposed || !this.current) return;
    this.element.currentTime = 0;
    this.position = 0;
    this.state = 'loading';
    this.error = null;
    this.emit();
    await this.startElement();
  }

  private async startElement(): Promise<void> {
    try {
      await this.engine.resume();
      await this.element.play();
    } catch (error) {
      this.fail(isAbortError(error) ? 'aborted' : 'unknown', describe(error));
    }
  }

  private async prepareSource(url: string, signal: AbortSignal): Promise<PreparedSource> {
    try {
      const response = await fetch(url, { signal });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const declared = Number(response.headers.get('content-length') ?? 0);
      if (declared > MAX_BLOB_BYTES) return { src: url, objectUrl: null };

      const blob = await response.blob();
      if (blob.size > MAX_BLOB_BYTES) return { src: url, objectUrl: null };

      const objectUrl = URL.createObjectURL(blob);
      return { src: objectUrl, objectUrl };
    } catch (error) {
      if (signal.aborted) throw error;
      console.info(`[player] blob load failed, using direct source: ${describe(error)}`);
      return { src: url, objectUrl: null };
    }
  }

  private attachSource(src: string, objectUrl: string | null): void {
    const previousObjectUrl = this.objectUrl;
    this.element.src = src;
    this.element.load();
    this.objectUrl = objectUrl;

    // Revoke only after the new source is attached. Revoking first can abort the load
    // that is still current.
    if (previousObjectUrl) URL.revokeObjectURL(previousObjectUrl);
  }

  private replaceQueue(track: Track, queue?: Track[]): void {
    const list = queue && queue.length > 0 ? queue.slice() : [track];
    let index = list.findIndex((candidate) => candidate.id === track.id);
    if (index === -1) {
      list.unshift(track);
      index = 0;
    }
    list[index] = track;
    this.queue = list;
    this.index = index;
  }

  private pickNextIndex(): number | null {
    if (this.queue.length === 1) return 0;
    if (this.shuffleOn) return randomOtherIndex(this.index, this.queue.length);

    const candidate = this.index + 1;
    if (candidate < this.queue.length) return candidate;
    return this.repeatMode === 'all' ? 0 : null;
  }

  private refreshDuration(): void {
    const metadata = this.current?.durationSec ?? 0;
    const raw = this.element.duration;
    const elementDuration = Number.isFinite(raw) && raw > 0 ? raw : 0;

    if (metadata > 0 && elementDuration > 0) {
      const ratio = elementDuration / metadata;
      if (ratio > 1 + DURATION_TOLERANCE || ratio < 1 - DURATION_TOLERANCE) {
        if (this.lastLoggedElementDuration !== elementDuration) {
          this.lastLoggedElementDuration = elementDuration;
          console.info(
            `[player] duration mismatch: element ${elementDuration.toFixed(1)}s vs metadata ${metadata.toFixed(1)}s — using metadata`,
          );
        }
      }
      this.duration = metadata;
      return;
    }

    this.duration = metadata > 0 ? metadata : elementDuration;
  }

  private isCurrent(token: number): boolean {
    return !this.disposed && token === this.token;
  }

  private reportAborted(token: number): void {
    if (this.disposed || token === this.token) return;
    // A newer request may already be playing. Do not paint an abort error over it.
    if (this.state === 'playing' || this.state === 'paused') return;
    this.error = { code: 'aborted', message: 'superseded by a newer play request' };
    this.emit();
  }

  private fail(code: PlayerErrorCode, message: string): void {
    if (this.disposed) return;
    this.error = { code, message };
    this.state = 'error';
    this.emit();
  }

  private abortPreparation(): void {
    if (!this.preparation) return;
    this.preparation.abort();
    this.preparation = null;
  }

  private emit(): void {
    if (this.disposed) return;
    this.snapshot = this.buildSnapshot();
    for (const listener of [...this.listeners]) {
      try {
        listener();
      } catch (error) {
        console.error('[player] subscriber failed', error);
      }
    }
  }

  private buildSnapshot(): PlayerSnapshot {
    return {
      state: this.state,
      track: this.current,
      positionSec: this.position,
      durationSec: this.duration,
      queue: this.queue.slice(),
      index: this.index,
      shuffle: this.shuffleOn,
      repeat: this.repeatMode,
      error: this.error,
    };
  }
}

function randomOtherIndex(current: number, length: number): number {
  if (current < 0) return Math.floor(Math.random() * length);
  const offset = Math.floor(Math.random() * (length - 1));
  return offset >= current ? offset + 1 : offset;
}

function isAbortError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'name' in error &&
    (error as { name?: unknown }).name === 'AbortError'
  );
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}