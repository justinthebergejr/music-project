import { getAudioEngine } from '../audio/AudioEngine';
import { resolveTrackSource } from '../platform/media';
import { PlayerController } from './PlayerController';

let controller: PlayerController | null = null;

/**
 * The controller is a process singleton, like the audio graph.
 *
 * A second controller would create a second `<audio>` element; `engine.attach()` is
 * idempotent and would leave that element unconnected, which is a silent failure. React
 * StrictMode therefore cannot accidentally create one.
 */
export function getPlayerController(): PlayerController {
  if (!controller) {
    controller = new PlayerController({
      engine: getAudioEngine(),
      resolveSource: resolveTrackSource,
    });
  }
  return controller;
}