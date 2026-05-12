import { useState, useEffect } from 'react';
import { getAllListings } from '@/services';
import type { Listing } from '@/services';

interface UseListingsReturn {
  listings: Listing[];
  loading: boolean;
  error: Error | null;
  refetch: () => Promise<void>;
}

export const useListings = (limit = 1000): UseListingsReturn => {
  const [listings, setListings] = useState<Listing[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);

  const fetchListings = async () => {
    try {
      setLoading(true);
      setError(null);
      const result = await getAllListings(limit);
      // Exclude source-specific tables from the main listings view
      const excludedSources = new Set(["propwire", "zillow", "redfin", "realtor"]);
      const filtered = result.listings.filter((l) => !excludedSources.has(l.source));
      setListings(filtered);
    } catch (err) {
      setError(err instanceof Error ? err : new Error('Failed to fetch listings'));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchListings();
  }, [limit]);

  return {
    listings,
    loading,
    error,
    refetch: fetchListings,
  };
};
