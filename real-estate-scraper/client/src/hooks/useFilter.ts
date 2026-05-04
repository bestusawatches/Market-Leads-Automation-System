import { useState, useEffect } from 'react';
import { getFilter, updateFilter as updateFilterApi } from '@/services';
import type { SavedFilter, FilterCriteria } from '@/services';

interface UseFilterReturn {
  filter: SavedFilter | null;
  loading: boolean;
  error: Error | null;
  updateFilter: (filter: FilterCriteria) => Promise<SavedFilter>;
  refetch: () => Promise<void>;
}

export const useFilter = (): UseFilterReturn => {
  const [filter, setFilter] = useState<SavedFilter | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);

  const fetchFilter = async () => {
    try {
      setLoading(true);
      setError(null);
      const result = await getFilter();
      setFilter(result);
    } catch (err) {
      setError(err instanceof Error ? err : new Error('Failed to fetch filter'));
    } finally {
      setLoading(false);
    }
  };

  const updateFilterHandler = async (filterData: FilterCriteria): Promise<SavedFilter> => {
    try {
      setError(null);
      const updated = await updateFilterApi(filterData);
      setFilter(updated);
      return updated;
    } catch (err) {
      const error = err instanceof Error ? err : new Error('Failed to update filter');
      setError(error);
      throw error;
    }
  };

  useEffect(() => {
    fetchFilter();
  }, []);

  return {
    filter,
    loading,
    error,
    updateFilter: updateFilterHandler,
    refetch: fetchFilter,
  };
};
