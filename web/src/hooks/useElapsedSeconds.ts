import { useEffect, useState } from 'react';

/** Whole seconds elapsed since `startedAt` (ms epoch), ticking while it is non-null. Long OCR runs need visible progress. */
export function useElapsedSeconds(startedAt: number | null): number {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (startedAt === null) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [startedAt]);

  return startedAt === null ? 0 : Math.max(0, Math.floor((now - startedAt) / 1000));
}
