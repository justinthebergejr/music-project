import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import type { AudioEngine } from '../audio/AudioEngine';
import type { Track } from '../library/types';
import { PlayerController } from './PlayerController';

let lastAudio: FakeAudio | undefined;
let objectUrlCounter = 0;

class FakeAudio extends EventTarget {
  src = '';
  currentTime = 0;
  duration = Number.NaN;
  paused = true;
  ended = false;
  crossOrigin = '';
  preload = '';
  error: { code: number; message: string } | null = null;
  playCalls = 0;

  constructor() {
    super();
    lastAudio = this;
  }

  load(): void {}

  removeAttribute(name: string): void {
    if (name === 'src') this.src = '';
  }

  play(): Promise<void> {
    this.playCalls += 1;
    this.paused = false;
    this.ended = false;
    this.dispatchEvent(new Event('play'));
    return Promise.resolve();
  }

  pause(): void {
    this.paused = true;
    this.dispatchEvent(new Event('pause'));
  }
}

interface FakeEngine {
  attach: Mock;
  resume: Mock;
  setVolume: Mock;
}

function fakeEngine(): FakeEngine {
  return {
    attach: vi.fn(),
    resume: vi.fn(async () => undefined),
    setVolume: vi.fn(),
  };
}

function engineArg(engine: FakeEngine): AudioEngine {
  return engine as unknown as AudioEngine;
}

function audio(): FakeAudio {
  if (!lastAudio) throw new Error('the controller did not create an audio element');
  return lastAudio;
}

function makeTrack(id: string, durationSec = 100): Track {
  const youtube = id.startsWith('yt:');
  return {
    id,
    title: id,
    artist: null,
    album: null,
    durationSec,
    source: youtube ? 'youtube' : 'local',
    artUrl: null,
    filePath: youtube ? null : `/music/${id}.flac`,
    addedAt: 0,
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

beforeEach(() => {
  lastAudio = undefined;
  objectUrlCounter = 0;

  vi.stubGlobal('Audio', FakeAudio as unknown as typeof Audio);
  vi.spyOn(URL, 'createObjectURL').mockImplementation(() => `blob:test-${++objectUrlCounter}`);
  vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => undefined);
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => ({
      ok: true,
      status: 200,
      headers: new Headers({ 'content-length': '4' }),
      blob: async () => new Blob(['abcd']),
    })),
  );
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('PlayerController', () => {
  it('creates the element once and moves idle -> loading -> playing', async () => {
    const engine = fakeEngine();
    const resolver = deferred<string>();
    const controller = new PlayerController({
      engine: engineArg(engine),
      resolveSource: () => resolver.promise,
    });

    expect(controller.getSnapshot().state).toBe('idle');
    expect(engine.attach).toHaveBeenCalledTimes(1);
    expect(engine.attach).toHaveBeenCalledWith(audio());

    const playback = controller.playTrack(makeTrack('yt:a'));
    expect(controller.getSnapshot().state).toBe('loading');

    resolver.resolve('http://127.0.0.1/m/token/a');
    await playback;

    expect(controller.getSnapshot().state).toBe('playing');
    expect(controller.getSnapshot().track?.id).toBe('yt:a');
    expect(audio().playCalls).toBe(1);
  });

  it('pauses and resumes without creating another element', async () => {
    const engine = fakeEngine();
    const controller = new PlayerController({
      engine: engineArg(engine),
      resolveSource: async (track) => `http://127.0.0.1/m/${track.id}`,
    });

    await controller.playTrack(makeTrack('yt:a'));
    controller.pause();
    expect(controller.getSnapshot().state).toBe('paused');

    await controller.play();
    expect(controller.getSnapshot().state).toBe('playing');
    expect(engine.attach).toHaveBeenCalledTimes(1);
    expect(audio().playCalls).toBe(2);
  });

  it('advances the queue when the current track ends', async () => {
    const engine = fakeEngine();
    const controller = new PlayerController({
      engine: engineArg(engine),
      resolveSource: async (track) => `http://127.0.0.1/m/${track.id}`,
    });
    const first = makeTrack('yt:a');
    const second = makeTrack('yt:b');

    await controller.playTrack(first, [first, second]);
    audio().dispatchEvent(new Event('ended'));

    await vi.waitFor(() => {
      expect(controller.getSnapshot().track?.id).toBe('yt:b');
      expect(controller.getSnapshot().state).toBe('playing');
    });
    expect(audio().playCalls).toBe(2);
  });

  it("replays the current track when repeat is 'one'", async () => {
    const engine = fakeEngine();
    const controller = new PlayerController({
      engine: engineArg(engine),
      resolveSource: async (track) => `http://127.0.0.1/m/${track.id}`,
    });
    const first = makeTrack('yt:a');
    const second = makeTrack('yt:b');

    controller.setRepeat('one');
    await controller.playTrack(first, [first, second]);
    audio().dispatchEvent(new Event('ended'));

    await vi.waitFor(() => expect(audio().playCalls).toBe(2));
    expect(controller.getSnapshot().track?.id).toBe('yt:a');
    expect(audio().currentTime).toBe(0);
  });

  it('reports a resolver failure and never plays', async () => {
    const engine = fakeEngine();
    const controller = new PlayerController({
      engine: engineArg(engine),
      resolveSource: async () => {
        throw new Error('network unavailable');
      },
    });

    await controller.playTrack(makeTrack('yt:a'));

    const snapshot = controller.getSnapshot();
    expect(snapshot.state).toBe('error');
    expect(snapshot.error).toEqual({ code: 'resolve', message: 'network unavailable' });
    expect(audio().playCalls).toBe(0);
  });

  it('lets only the newest of two concurrent playTrack calls play', async () => {
    const engine = fakeEngine();
    const first = deferred<string>();
    const second = deferred<string>();
    let call = 0;

    const controller = new PlayerController({
      engine: engineArg(engine),
      resolveSource: () => {
        call += 1;
        return call === 1 ? first.promise : second.promise;
      },
    });

    const firstPlayback = controller.playTrack(makeTrack('yt:a'));
    const secondPlayback = controller.playTrack(makeTrack('yt:b'));

    first.resolve('http://127.0.0.1/m/a');
    await vi.waitFor(() => expect(controller.getSnapshot().error?.code).toBe('aborted'));
    expect(audio().playCalls).toBe(0);

    second.resolve('http://127.0.0.1/m/b');
    await Promise.all([firstPlayback, secondPlayback]);

    expect(audio().playCalls).toBe(1);
    expect(URL.createObjectURL).toHaveBeenCalledTimes(1);
    expect(controller.getSnapshot().track?.id).toBe('yt:b');
    expect(controller.getSnapshot().state).toBe('playing');
  });

  it('uses metadata duration when the element reports exactly double', async () => {
    const engine = fakeEngine();
    const controller = new PlayerController({
      engine: engineArg(engine),
      resolveSource: async () => 'http://127.0.0.1/m/track',
    });
    const info = vi.spyOn(console, 'info').mockImplementation(() => undefined);

    await controller.playTrack(makeTrack('yt:a', 191.4));
    audio().duration = 382.8;
    audio().dispatchEvent(new Event('loadedmetadata'));

    expect(controller.getSnapshot().durationSec).toBeCloseTo(191.4);
    expect(info).toHaveBeenCalledWith(expect.stringContaining('382.8'));
  });

  it('starts engine.resume before the resolver can await', async () => {
    const engine = fakeEngine();
    let resumed = false;
    engine.resume.mockImplementation(async () => {
      resumed = true;
    });

    const controller = new PlayerController({
      engine: engineArg(engine),
      resolveSource: async () => {
        expect(resumed).toBe(true);
        return 'http://127.0.0.1/m/track';
      },
    });

    await controller.playTrack(makeTrack('yt:a'));
  });

  it('revokes the active object URL on dispose', async () => {
    const engine = fakeEngine();
    const controller = new PlayerController({
      engine: engineArg(engine),
      resolveSource: async () => 'http://127.0.0.1/m/track',
    });

    await controller.playTrack(makeTrack('yt:a'));
    const objectUrl = audio().src;
    controller.dispose();

    expect(URL.revokeObjectURL).toHaveBeenCalledWith(objectUrl);
    expect(controller.getSnapshot().state).toBe('idle');
    expect(controller.getSnapshot().queue).toEqual([]);
  });

  it('ignores a resolve that finishes after dispose', async () => {
    const engine = fakeEngine();
    const resolver = deferred<string>();
    const controller = new PlayerController({
      engine: engineArg(engine),
      resolveSource: () => resolver.promise,
    });

    const playback = controller.playTrack(makeTrack('yt:a'));
    controller.dispose();
    resolver.resolve('http://127.0.0.1/m/a');
    await playback;

    expect(audio().playCalls).toBe(0);
    expect(controller.getSnapshot().state).toBe('idle');
  });
});