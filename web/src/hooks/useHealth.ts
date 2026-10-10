import { useEffect, useState } from 'react';
import type { ApiClient, HealthStatus } from '../api/client';
import { toApiError } from '../api/client';

export type HealthState =
  | { status: 'checking' }
  | { status: 'ok' | 'degraded'; health: HealthStatus }
  | { status: 'unreachable'; message: string };

/** Polls GET /api/health once on mount (and every `intervalMs`) so the header can warn about missing OCR tools early. */
export function useHealth(client: ApiClient, intervalMs = 60_000): HealthState {
  const [state, setState] = useState<HealthState>({ status: 'checking' });

  useEffect(() => {
    let cancelled = false;
    const check = async () => {
      try {
        const health = await client.health();
        const degraded = !health.ok || (health.missing?.length ?? 0) > 0;
        if (!cancelled) setState({ status: degraded ? 'degraded' : 'ok', health });
      } catch (err) {
        if (!cancelled) setState({ status: 'unreachable', message: toApiError(err).error });
      }
    };
    void check();
    const timer = intervalMs > 0 ? setInterval(check, intervalMs) : undefined;
    return () => {
      cancelled = true;
      if (timer) clearInterval(timer);
    };
  }, [client, intervalMs]);

  return state;
}
