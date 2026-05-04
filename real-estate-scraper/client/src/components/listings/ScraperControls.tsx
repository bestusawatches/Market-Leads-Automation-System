import React, { useState, useEffect } from 'react';
import { useScraper } from '@/hooks';
import { AVAILABLE_SOURCES } from '@/services/types';

export const ScraperControls: React.FC<{ onScrapingStart?: () => void }> = ({ onScrapingStart }) => {
  const { triggering, error, success, lastTriggeredAt, trigger, reset } = useScraper();
  const [selectedSource, setSelectedSource] = useState('all');
  const [showSuccessMessage, setShowSuccessMessage] = useState(false);

  useEffect(() => {
    if (success) {
      setShowSuccessMessage(true);
      const timer = setTimeout(() => setShowSuccessMessage(false), 5000);
      return () => clearTimeout(timer);
    }
  }, [success]);

  const handleTrigger = async () => {
    await trigger(selectedSource);
    onScrapingStart?.();
  };

  return (
    <div className="bg-gradient-to-r from-indigo-50 to-blue-50 p-6 rounded-lg border border-indigo-200 shadow-sm">
      <div className="flex flex-col sm:flex-row gap-4 items-start sm:items-end">
        {/* Source Selector */}
        <div className="flex-1 min-w-0">
          <label htmlFor="source-select" className="block text-sm font-semibold text-gray-700 mb-2">
            Select Data Source to Scrape
          </label>
          <select
            id="source-select"
            value={selectedSource}
            onChange={(e) => {
              setSelectedSource(e.target.value);
              reset();
            }}
            disabled={triggering}
            className="w-full px-4 py-2 border border-gray-300 rounded-lg bg-white text-gray-900 font-medium focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-transparent disabled:bg-gray-100 disabled:cursor-not-allowed transition-colors"
          >
            {AVAILABLE_SOURCES.map((source) => (
              <option key={source.value} value={source.value}>
                {source.label}
              </option>
            ))}
          </select>
          <p className="mt-1 text-xs text-gray-600">
            {selectedSource === 'all' 
              ? 'This will trigger all available scrapers sequentially' 
              : 'This will scrape only the selected source'}
          </p>
        </div>

        {/* Trigger Button */}
        <button
          onClick={handleTrigger}
          disabled={triggering}
          className="w-full sm:w-auto px-6 py-2 bg-indigo-600 text-white rounded-lg hover:bg-indigo-700 transition-colors disabled:opacity-50 disabled:cursor-not-allowed font-semibold flex items-center justify-center gap-2 whitespace-nowrap"
        >
          {triggering ? (
            <>
              <span className="inline-block h-4 w-4 border-2 border-white border-t-transparent rounded-full animate-spin"></span>
              Running...
            </>
          ) : (
            <>
              <span>▶</span>
              Run Scraper
            </>
          )}
        </button>
      </div>

      {/* Success Message */}
      {showSuccessMessage && (
        <div className="mt-4 p-4 bg-green-50 border border-green-200 rounded-lg">
          <div className="flex items-center gap-2">
            <svg className="w-5 h-5 text-green-600" fill="currentColor" viewBox="0 0 20 20">
              <path fillRule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zm3.707-9.293a1 1 0 00-1.414-1.414L9 10.586 7.707 9.293a1 1 0 00-1.414 1.414l2 2a1 1 0 001.414 0l4-4z" clipRule="evenodd" />
            </svg>
            <div>
              <p className="font-semibold text-green-900">Scraping started successfully!</p>
              <p className="text-sm text-green-700">
                Started at {new Date(lastTriggeredAt || '').toLocaleTimeString()}
              </p>
            </div>
          </div>
        </div>
      )}

      {/* Error Message */}
      {error && (
        <div className="mt-4 p-4 bg-red-50 border border-red-200 rounded-lg">
          <div className="flex items-start gap-2">
            <svg className="w-5 h-5 text-red-600 mt-0.5 flex-shrink-0" fill="currentColor" viewBox="0 0 20 20">
              <path fillRule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zM8.707 7.293a1 1 0 00-1.414 1.414L8.586 10l-1.293 1.293a1 1 0 101.414 1.414L10 11.414l1.293 1.293a1 1 0 001.414-1.414L11.414 10l1.293-1.293a1 1 0 00-1.414-1.414L10 8.586 8.707 7.293z" clipRule="evenodd" />
            </svg>
            <div>
              <p className="font-semibold text-red-900">Failed to start scraper</p>
              <p className="text-sm text-red-700">{error.message}</p>
            </div>
          </div>
        </div>
      )}

      {/* Info Box */}
      <div className="mt-4 p-3 bg-blue-50 border border-blue-200 rounded text-sm text-blue-800">
        <p className="font-semibold mb-1">💡 Note:</p>
        <p>Scraping runs in the background and may take several minutes depending on the data source. You can continue browsing while scraping is in progress.</p>
      </div>
    </div>
  );
};
