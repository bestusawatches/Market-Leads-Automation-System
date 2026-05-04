import { useState } from 'react';
import { triggerScraper } from '@/services';
import type { UseScrapeReturn } from '@/services/types';

export const useScraper = (): UseScrapeReturn => {
  const [triggering, setTriggering] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  const [success, setSuccess] = useState(false);
  const [lastTriggeredAt, setLastTriggeredAt] = useState<string | null>(null);

  const trigger = async (source: string) => {
    try {
      setTriggering(true);
      setError(null);
      setSuccess(false);
      
      const response = await triggerScraper(source);
      
      if (response.status === 'ok') {
        setSuccess(true);
        setLastTriggeredAt(new Date().toISOString());
      } else {
        throw new Error(response.message || 'Failed to trigger scraper');
      }
    } catch (err) {
      setError(err instanceof Error ? err : new Error('Failed to trigger scraper'));
      setSuccess(false);
    } finally {
      setTriggering(false);
    }
  };

  const reset = () => {
    setError(null);
    setSuccess(false);
  };

  return {
    triggering,
    error,
    success,
    lastTriggeredAt,
    trigger,
    reset,
  };
};
