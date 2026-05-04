import { useState, useEffect } from 'react';
import { getAllProperties } from '@/services';
import type { Property } from '@/services';

interface UsePropertiesReturn {
  properties: Property[];
  loading: boolean;
  error: Error | null;
  refetch: () => Promise<void>;
}

export const useProperties = (limit = 1000): UsePropertiesReturn => {
  const [properties, setProperties] = useState<Property[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);

  const fetchProperties = async () => {
    try {
      setLoading(true);
      setError(null);
      const result = await getAllProperties(limit);
      setProperties(result.properties);
    } catch (err) {
      setError(err instanceof Error ? err : new Error('Failed to fetch properties'));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchProperties();
  }, [limit]);

  return {
    properties,
    loading,
    error,
    refetch: fetchProperties,
  };
};
