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
      setListings(result.listings);
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
