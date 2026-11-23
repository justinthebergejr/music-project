import { useCallback, useEffect, useState } from 'react';
import { ensureToolchain, onToolchainStatus, type ToolchainStatus } from '../../core/platform/toolchain';

/**
 * Launch-time toolchain bootstrap.
 *
 * The returned status is authoritative; progress events are a nicety. A failed event
 * subscription must not prevent the install from running, which is why both paths call
 * the same `apply` function.
 */
export function useToolchainStatus(
  onStatus: (status: ToolchainStatus) => void,
  onNote: (line: string) => void,
): { status: ToolchainStatus | null; recheck: () => void } {
  const [status, setStatus] = useState<ToolchainStatus | null>(null);

  const apply = useCallback(
    (next: ToolchainStatus) => {
      setStatus(next);
      onStatus(next);
    },
    [onStatus],
  );

  useEffect(() => {
    let unlisten: (() => void) | null = null;
    let cancelled = false;

    const handle = (next: ToolchainStatus) => {
      if (!cancelled) apply(next);
    };

    void (async () => {
      try {
        unlisten = await onToolchainStatus(handle);
      } catch (error) {
        onNote(`toolchain events unavailable: ${String(error)}`);
      }
      try {
        handle(await ensureToolchain(false));
      } catch (error) {
        handle({
          phase: 'error',
          version: null,
          path: null,
          detail: String(error),
          received: 0,
          total: 0,
        });
      }
    })();

    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, [apply, onNote]);

  const recheck = useCallback(() => {
    void ensureToolchain(true).then(apply);
  }, [apply]);

  return { status, recheck };
}