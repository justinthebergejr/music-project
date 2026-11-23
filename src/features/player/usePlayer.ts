import { useSyncExternalStore } from 'react';
import { getPlayerController } from '../../core/player';
import type { PlayerSnapshot } from '../../core/player/types';

export function usePlayer(): { controller: ReturnType<typeof getPlayerController>; snapshot: PlayerSnapshot } {
  const controller = getPlayerController();
  const snapshot = useSyncExternalStore(controller.subscribe, controller.getSnapshot);
  return { controller, snapshot };
}