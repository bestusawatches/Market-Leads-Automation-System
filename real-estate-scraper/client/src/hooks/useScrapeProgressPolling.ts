import { useEffect, useRef, useState } from "react";
import { getScrapeStatus } from "@/services/api";

export function useScrapeProgressPolling(poll = 2000) {
  const [status, setStatus] = useState<any>({ running: false, percent: 0 });
  const intervalRef = useRef<number | null>(null);

  useEffect(() => {
    let mounted = true;

    async function read() {
      try {
        const s = await getScrapeStatus();
        if (!mounted) return;
        setStatus(s);
      } catch (err) {
        // ignore network errors
      }
    }

    // initial fetch
    read();

    intervalRef.current = window.setInterval(read, poll);

    return () => {
      mounted = false;
      if (intervalRef.current) window.clearInterval(intervalRef.current);
    };
  }, [poll]);

  return status;
}
