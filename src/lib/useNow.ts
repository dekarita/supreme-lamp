import { useEffect, useState } from "react";

// Re-render tick for 1s-clock surfaces (bottom bar, banners). Returns Date.now()
// sampled every `intervalMs`; consumers derive display values from it.
export function useNow(intervalMs = 1000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), intervalMs);
    return () => window.clearInterval(id);
  }, [intervalMs]);
  return now;
}
