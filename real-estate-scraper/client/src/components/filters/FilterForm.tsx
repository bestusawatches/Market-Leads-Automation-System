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
    name: initialFilter?.name || '',
    description: initialFilter?.description || '',
    source: initialFilter?.source || '',
    minPrice: initialFilter?.minPrice || undefined,
    maxPrice: initialFilter?.maxPrice || undefined,
    propertyTypes: initialFilter?.propertyTypes || [],
    locations: initialFilter?.locations || [],
    keywords: initialFilter?.keywords || [],
    excludeKeywords: initialFilter?.excludeKeywords || [],
    minBedrooms: initialFilter?.minBedrooms || undefined,
    maxBedrooms: initialFilter?.maxBedrooms || undefined,
    minBathrooms: initialFilter?.minBathrooms || undefined,
    maxBathrooms: initialFilter?.maxBathrooms || undefined,
    minSquareFeet: initialFilter?.minSquareFeet || undefined,
    maxSquareFeet: initialFilter?.maxSquareFeet || undefined,
    minEquity: initialFilter?.minEquity || undefined,
    minArv: initialFilter?.minArv || undefined,
    isActive: initialFilter?.isActive !== false,
  });

  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);

  useEffect(() => {
    if (initialFilter) {
      setFormState({
        name: initialFilter.name || '',
        description: initialFilter.description || '',
        source: initialFilter.source || '',
        minPrice: initialFilter.minPrice,
        maxPrice: initialFilter.maxPrice,
        propertyTypes: initialFilter.propertyTypes || [],
        locations: initialFilter.locations || [],
        keywords: initialFilter.keywords || [],
        excludeKeywords: initialFilter.excludeKeywords || [],
        minBedrooms: initialFilter.minBedrooms,
        maxBedrooms: initialFilter.maxBedrooms,
        minBathrooms: initialFilter.minBathrooms,
        maxBathrooms: initialFilter.maxBathrooms,
        minSquareFeet: initialFilter.minSquareFeet,
        maxSquareFeet: initialFilter.maxSquareFeet,
        minEquity: initialFilter.minEquity,
        minArv: initialFilter.minArv,
        isActive: initialFilter.isActive !== false,
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
    field: 'locations' | 'propertyTypes' | 'keywords' | 'excludeKeywords',
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

    if (!formState.name.trim()) {
      setError('Filter name is required');
      return;
    }

    if (!formState.source.trim()) {
      setError('Source is required');
      return;
    }

    try {
      await onSubmit(formState);
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
        <h3 className="text-lg font-semibold mb-4 text-gray-900">Basic Information</h3>

        <div className="space-y-4">
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Filter Name</label>
            <input
              type="text"
              name="name"
              value={formState.name}
              onChange={handleChange}
              className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-indigo-500 focus:border-transparent"
              placeholder="e.g., Cleveland Under $150k"
              required
            />
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Description</label>
            <textarea
              name="description"
              value={formState.description || ''}
              onChange={handleChange}
              className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-indigo-500 focus:border-transparent"
              placeholder="Optional description"
              rows={3}
            />
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Source</label>
            <select
              name="source"
              value={formState.source}
              onChange={handleChange}
              className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-indigo-500 focus:border-transparent"
              required
            >
              <option value="">Select a source</option>
              <option value="craigslist">Craigslist</option>
              <option value="facebook">Facebook</option>
            </select>
          </div>
        </div>
      </Card>

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
        <h3 className="text-lg font-semibold mb-4 text-gray-900">Property Specifications</h3>

        <div className="grid grid-cols-2 gap-4 mb-4">
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Min Bedrooms</label>
            <input
              type="number"
              name="minBedrooms"
              value={formState.minBedrooms || ''}
              onChange={handleChange}
              className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-indigo-500 focus:border-transparent"
            />
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Max Bedrooms</label>
            <input
              type="number"
              name="maxBedrooms"
              value={formState.maxBedrooms || ''}
              onChange={handleChange}
              className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-indigo-500 focus:border-transparent"
            />
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Min Bathrooms</label>
            <input
              type="number"
              name="minBathrooms"
              value={formState.minBathrooms || ''}
              onChange={handleChange}
              step="0.5"
              className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-indigo-500 focus:border-transparent"
            />
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Max Bathrooms</label>
            <input
              type="number"
              name="maxBathrooms"
              value={formState.maxBathrooms || ''}
              onChange={handleChange}
              step="0.5"
              className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-indigo-500 focus:border-transparent"
            />
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Min Sq Ft</label>
            <input
              type="number"
              name="minSquareFeet"
              value={formState.minSquareFeet || ''}
              onChange={handleChange}
              className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-indigo-500 focus:border-transparent"
            />
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Max Sq Ft</label>
            <input
              type="number"
              name="maxSquareFeet"
              value={formState.maxSquareFeet || ''}
              onChange={handleChange}
              className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-indigo-500 focus:border-transparent"
            />
          </div>
        </div>
      </Card>

      <Card>
        <h3 className="text-lg font-semibold mb-4 text-gray-900">Investment Criteria</h3>

        <div className="space-y-4">
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Min Equity</label>
            <input
              type="number"
              name="minEquity"
              value={formState.minEquity || ''}
              onChange={handleChange}
              className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-indigo-500 focus:border-transparent"
              placeholder="Minimum equity estimate"
            />
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Min ARV</label>
            <input
              type="number"
              name="minArv"
              value={formState.minArv || ''}
              onChange={handleChange}
              className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-indigo-500 focus:border-transparent"
              placeholder="Minimum home value estimate"
            />
          </div>
        </div>
      </Card>

      <Card>
        <h3 className="text-lg font-semibold mb-4 text-gray-900">Keywords & Locations</h3>

        <div className="space-y-4">
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Locations (comma-separated)</label>
            <input
              type="text"
              value={(formState.locations || []).join(', ')}
              onChange={(e) => handleArrayChange('locations', e.target.value)}
              className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-indigo-500 focus:border-transparent"
              placeholder="e.g., Cleveland, OH; Milwaukee, WI"
            />
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Keywords (comma-separated)</label>
            <input
              type="text"
              value={(formState.keywords || []).join(', ')}
              onChange={(e) => handleArrayChange('keywords', e.target.value)}
              className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-indigo-500 focus:border-transparent"
              placeholder="e.g., investment; rental; fixer"
            />
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Exclude Keywords (comma-separated)</label>
            <input
              type="text"
              value={(formState.excludeKeywords || []).join(', ')}
              onChange={(e) => handleArrayChange('excludeKeywords', e.target.value)}
              className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-indigo-500 focus:border-transparent"
              placeholder="e.g., lease; commercial; HOA"
            />
          </div>
        </div>
      </Card>

      <Card>
        <label className="flex items-center gap-2">
          <input
            type="checkbox"
            name="isActive"
            checked={formState.isActive}
            onChange={handleChange}
            className="w-4 h-4 rounded border-gray-300 focus:ring-indigo-500"
          />
          <span className="text-sm font-medium text-gray-700">Active Filter</span>
        </label>
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
