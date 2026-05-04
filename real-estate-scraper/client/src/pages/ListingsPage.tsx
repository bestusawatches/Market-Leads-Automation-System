import React, { useState } from 'react';
import { Header, PageContainer } from '@/components/layout';
import { ListingsTable, ScraperControls } from '@/components/listings';
import { ExportButton } from '@/components/common';
import { FilterBar } from '@/components/filters';
import { useListings } from '@/hooks';

export const ListingsPage: React.FC = () => {
  const { listings, loading, error, refetch } = useListings();
  const [filteredListings, setFilteredListings] = useState(listings);
  const [autoRefresh, setAutoRefresh] = useState(false);
  const [lastRefreshTime, setLastRefreshTime] = useState<string>(new Date().toISOString());

  const handleFilter = () => {
    // TODO: Implement client-side filtering based on quick filters
    setFilteredListings(listings);
  };

  const handleRefresh = async () => {
    await refetch();
    setLastRefreshTime(new Date().toISOString());
  };

  const handleScrapingStart = () => {
    // Enable auto-refresh or show a notification
    setAutoRefresh(true);
    // Set a timer to refresh listings after scraping might complete
    const refreshTimer = setTimeout(() => {
      handleRefresh();
      setAutoRefresh(false);
    }, 30000); // Refresh after 30 seconds as a sample check
    return () => clearTimeout(refreshTimer);
  };

  React.useEffect(() => {
    setFilteredListings(listings);
  }, [listings]);

  return (
    <PageContainer>
      <Header
        title="Listings"
        subtitle="Browse all property listings from your scraper sources"
      />

      <div className="p-8">
        {/* Scraper Controls Section */}
        <div className="mb-8">
          <ScraperControls onScrapingStart={handleScrapingStart} />
        </div>

        {/* Refresh and Additional Controls */}
        <div className="mb-6 flex gap-4 items-center flex-wrap">
          <button
            onClick={handleRefresh}
            disabled={loading}
            className="px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition-colors disabled:opacity-50 disabled:cursor-not-allowed font-medium flex items-center gap-2"
          >
            {loading ? (
              <>
                <span className="inline-block h-4 w-4 border-2 border-white border-t-transparent rounded-full animate-spin"></span>
                Refreshing...
              </>
            ) : (
              <>
                <span>🔄</span>
                Refresh Listings
              </>
            )}
          </button>
          <ExportButton 
            data={filteredListings} 
            filename="listings" 
            dataType="listings"
            disabled={loading}
          />
          {autoRefresh && (
            <span className="text-sm text-blue-600 font-medium flex items-center gap-2">
              <span className="inline-block h-2 w-2 bg-blue-600 rounded-full animate-pulse"></span>
              Auto-refreshing...
            </span>
          )}
        </div>

        {/* Filter Bar */}
        <FilterBar
          onMinPriceChange={() => handleFilter()}
          onMaxPriceChange={() => handleFilter()}
          onBedroomsChange={() => handleFilter()}
          onLocationChange={() => handleFilter()}
        />

        {/* Error Display */}
        {error && (
          <div className="bg-red-50 border border-red-200 text-red-800 px-4 py-3 rounded mb-4 flex items-start gap-2">
            <span className="text-xl mt-0.5">⚠️</span>
            <div>
              <p className="font-semibold">Error loading listings</p>
              <p className="text-sm">{error.message}</p>
            </div>
          </div>
        )}

        {/* Listings Table */}
        <div className="bg-white rounded-lg shadow overflow-hidden">
          {filteredListings.length === 0 && !loading ? (
            <div className="p-8 text-center">
              <p className="text-gray-500 text-lg mb-4">No listings found</p>
              <p className="text-gray-400 text-sm">
                Try running a scraper above to fetch new listings
              </p>
            </div>
          ) : (
            <ListingsTable listings={filteredListings} loading={loading} />
          )}
        </div>

        {/* Summary Footer */}
        <div className="mt-4 flex justify-between items-center text-gray-600 text-sm">
          <div>
            Showing <span className="font-semibold text-gray-900">{filteredListings.length}</span> listings
          </div>
          <div className="text-gray-500">
            Last updated: {new Date(lastRefreshTime).toLocaleTimeString()}
          </div>
        </div>
      </div>
    </PageContainer>
  );
};
