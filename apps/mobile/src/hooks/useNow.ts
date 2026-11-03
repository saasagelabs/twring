import { useEffect, useState } from 'react';

/** The current time, refreshed every `ms` so relative times ("8 min ago") stay true. */
export function useNow(ms = 30_000): Date {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const handle = setInterval(() => setNow(new Date()), ms);
    return () => clearInterval(handle);
  }, [ms]);
  return now;
}
