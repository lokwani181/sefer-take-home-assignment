/**
 * Tiny promise pool. Shared across concurrent ingest() calls so N uploads don't spawn N × pages
 * tesseract processes at once (CPU oversubscription and ~30 MB of pixels per in-flight page).
 */
import { availableParallelism, cpus } from 'node:os';

export interface Limiter {
  <T>(task: () => Promise<T>): Promise<T>;
  readonly size: number;
}

export function createLimiter(size: number): Limiter {
  const max = Math.max(1, Math.floor(size));
  let active = 0;
  const queue: Array<() => void> = [];

  const next = () => {
    if (active >= max) return;
    const start = queue.shift();
    if (start) start();
  };

  const run = <T>(task: () => Promise<T>): Promise<T> =>
    new Promise<T>((resolve, reject) => {
      queue.push(() => {
        active++;
        task()
          .then(resolve, reject)
          .finally(() => {
            active--;
            next();
          });
      });
      next();
    });

  return Object.assign(run, { size: max });
}

/** Default pool size: half the logical CPUs (tesseract is CPU-bound), overridable with INGEST_CONCURRENCY. */
export function defaultPoolSize(env: NodeJS.ProcessEnv = process.env): number {
  const fromEnv = Number(env.INGEST_CONCURRENCY);
  if (Number.isFinite(fromEnv) && fromEnv >= 1) return Math.floor(fromEnv);
  const n = typeof availableParallelism === 'function' ? availableParallelism() : cpus().length;
  return Math.max(1, Math.floor(n / 2));
}
