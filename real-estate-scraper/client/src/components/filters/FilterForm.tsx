import React, { useState, useEffect } from 'react';
import { Card } from '../common';
import type { SavedFilter, FilterCriteria } from '../../services/types';

interface FilterFormProps {
  initialFilter?: SavedFilter | null;
  onSubmit: (filter: FilterCriteria) => Promise<void>;
  loading?: boolean;
}

export const FilterForm: React.FC<FilterFormProps> = ({
  initialFilter,
  onSubmit,
  loading = false,
}) => {
  const [formState, setFormState] = useState<FilterCriteria>({
    minPrice: initialFilter?.minPrice || undefined,
    maxPrice: initialFilter?.maxPrice || undefined,
    allowedPropertyTypes: initialFilter?.allowedPropertyTypes || [],
    keywords: initialFilter?.keywords || [],
    propertyTypeTokens: initialFilter?.propertyTypeTokens || [],
    allowedLocations: initialFilter?.allowedLocations || [],
  });

  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);

  useEffect(() => {
    if (initialFilter) {
      setFormState({
        minPrice: initialFilter.minPrice,
        maxPrice: initialFilter.maxPrice,
        allowedPropertyTypes: initialFilter.allowedPropertyTypes || [],
        keywords: initialFilter.keywords || [],
        propertyTypeTokens: initialFilter.propertyTypeTokens || [],
        allowedLocations: initialFilter.allowedLocations || [],
      });
    }
  }, [initialFilter]);

  const handleChange = (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>) => {
    const { name, value, type } = e.target;

    setFormState((prev) => ({
      ...prev,
      [name]:
        type === 'checkbox'
          ? (e.target as HTMLInputElement).checked
          : type === 'number'
            ? value === ''
              ? undefined
              : parseInt(value, 10)
            : value,
    }));
  };

  const handleArrayChange = (
    field: 'allowedLocations' | 'allowedPropertyTypes' | 'keywords' | 'propertyTypeTokens',
    value: string
  ) => {
    const items = value.split(',').map((item) => item.trim()).filter(Boolean);
    setFormState((prev) => ({
      ...prev,
      [field]: items,
    }));
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setSuccess(false);

    // No longer require name/source in simplified schema

    try {
      // Cast to any to match API payload shape
      await onSubmit(formState as any);
      setSuccess(true);
      setTimeout(() => setSuccess(false), 3000);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save filter');
    }
  };

  return (
    <form onSubmit={handleSubmit} className="max-w-2xl mx-auto space-y-6">
      {error && (
        <div className="bg-red-50 border border-red-200 text-red-800 px-4 py-3 rounded">
          {error}
        </div>
      )}

      {success && (
        <div className="bg-green-50 border border-green-200 text-green-800 px-4 py-3 rounded">
          Filter saved successfully!
        </div>
      )}

      <Card>
        <h3 className="text-lg font-semibold mb-4 text-gray-900">Price Range</h3>

        <div className="grid grid-cols-2 gap-4">
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Min Price</label>
            <input
              type="number"
              name="minPrice"
              value={formState.minPrice || ''}
              onChange={handleChange}
              className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-indigo-500 focus:border-transparent"
              placeholder="0"
            />
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Max Price</label>
            <input
              type="number"
              name="maxPrice"
              value={formState.maxPrice || ''}
              onChange={handleChange}
              className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-indigo-500 focus:border-transparent"
              placeholder="999999"
            />
          </div>
        </div>
      </Card>

      <Card>
        <h3 className="text-lg font-semibold mb-4 text-gray-900">Property Types</h3>
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">Allowed Property Types (comma-separated)</label>
          <input
            type="text"
            value={(formState.allowedPropertyTypes || []).join(', ')}
            onChange={(e) => handleArrayChange('allowedPropertyTypes', e.target.value)}
            className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-indigo-500 focus:border-transparent"
            placeholder="single_family, multi_family, duplex"
          />
        </div>
        <div className="mt-4">
          <label className="block text-sm font-medium text-gray-700 mb-1">Property Type Tokens (comma-separated)</label>
          <input
            type="text"
            value={(formState.propertyTypeTokens || []).join(', ')}
            onChange={(e) => handleArrayChange('propertyTypeTokens', e.target.value)}
            className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-indigo-500 focus:border-transparent"
            placeholder="single family, single-family, sfh, duplex"
          />
        </div>
      </Card>

      <Card>
        <h3 className="text-lg font-semibold mb-4 text-gray-900">Keywords & Locations</h3>
        <div className="space-y-4">
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Keywords (comma-separated)</label>
            <input
              type="text"
              value={(formState.keywords || []).join(', ')}
              onChange={(e) => handleArrayChange('keywords', e.target.value)}
              className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-indigo-500 focus:border-transparent"
              placeholder="investment, rental, duplex"
            />
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Allowed Locations (comma-separated)</label>
            <input
              type="text"
              value={(formState.allowedLocations || []).join(', ')}
              onChange={(e) => handleArrayChange('allowedLocations', e.target.value)}
              className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-indigo-500 focus:border-transparent"
              placeholder="ohio, cleveland, columbus, milwaukee"
            />
          </div>
        </div>
      </Card>

      <div className="flex gap-4">
        <button
          type="submit"
          disabled={loading}
          className="flex-1 bg-indigo-600 text-white py-3 rounded-lg hover:bg-indigo-700 transition-colors font-semibold disabled:opacity-50"
        >
          {loading ? 'Saving...' : 'Save Filter'}
        </button>
      </div>
    </form>
  );
};
