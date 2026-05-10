import React, { useState, useEffect, useMemo } from 'react';
import { Header, PageContainer } from '@/components/layout';
import { ExportButton } from '@/components/common';
import { useProperties } from '@/hooks';
import { 
  getZillowListings, 
  getRedfinListings, 
  getRealtorListings, 
  getPropwireListings 
} from '@/services/api';
import type { SourceListingsPayload } from '@/services/types';

// Unified listing format for display
interface UnifiedListing {
  id: string;
  address: string;
  price?: number;
  url?: string;
  source: string;
  estimate?: number;
  estimatedArv?: number; // After Repair Value (median estimate or individual estimate)
  arv?: number; // (price + 50000) / estimatedArv, rounded to 2 decimals
}

// Helper: Calculate median of values
const calculateMedian = (values: number[]): number | undefined => {
  if (values.length === 0) return undefined;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[mid - 1] + sorted[mid]) / 2
    : sorted[mid];
};

// Helper: Calculate ARV ratio (price + repair cost) / estimatedArv
const calculateArv = (price?: number, estimatedArv?: number): number | undefined => {
  if (price === undefined || estimatedArv === undefined || estimatedArv === 0) return undefined;
  const ratio = (price + 50000) / estimatedArv;
  return Math.round(ratio * 100) / 100; // Round to 2 decimal places
};

export const PropertiesPage: React.FC = () => {
  const { properties, loading, error, refetch } = useProperties();
  const [sourceListings, setSourceListings] = useState<{
    zillow: SourceListingsPayload | null;
    redfin: SourceListingsPayload | null;
    realtor: SourceListingsPayload | null;
    propwire: SourceListingsPayload | null;
  }>({
    zillow: null,
    redfin: null,
    realtor: null,
    propwire: null,
  });
  const [sourceLoading, setSourceLoading] = useState(false);
  const [sourceError, setSourceError] = useState<Error | null>(null);

  // Fetch source-specific listings
  useEffect(() => {
    const fetchSourceListings = async () => {
      setSourceLoading(true);
      setSourceError(null);
      try {
        const [zillowData, redfinData, realtorData, propwireData] = await Promise.all([
          getZillowListings(1000),
          getRedfinListings(1000),
          getRealtorListings(1000),
          getPropwireListings(1000),
        ]);
        setSourceListings({
          zillow: zillowData,
          redfin: redfinData,
          realtor: realtorData,
          propwire: propwireData,
        });
      } catch (err) {
        setSourceError(err instanceof Error ? err : new Error('Failed to fetch source listings'));
      } finally {
        setSourceLoading(false);
      }
    };

    fetchSourceListings();
  }, []);

  // Combine all listings into unified format
  const unifiedListings = useMemo(() => {
    const listings: UnifiedListing[] = [];

    // Add listings from properties endpoint
    // estimatedArv = median of all estimates for this property
    properties.forEach((property) => {
      const estimatedArv = calculateMedian(property.estimates.map((est) => est.value));
      
      property.listings.forEach((listing) => {
        // Find matching estimate for this listing/source
        const estimate = property.estimates.find(
          (est) => est.source === listing.source
        );
        const arv = calculateArv(listing.price, estimatedArv);
        listings.push({
          id: listing.id,
          address: property.normalizedAddress || property.address || 'N/A',
          price: listing.price,
          url: listing.url,
          source: listing.source,
          estimate: estimate?.value,
          estimatedArv, // median of all estimates
          arv,
        });
      });
    });

    // Add Zillow listings
    // estimatedArv = individual zestimate
    sourceListings.zillow?.listings.forEach((listing: any) => {
      const arv = calculateArv(listing.price, listing.zestimate);
      listings.push({
        id: listing.id,
        address: listing.address || 'N/A',
        price: listing.price,
        url: listing.url,
        source: 'zillow',
        estimate: listing.zestimate,
        estimatedArv: listing.zestimate,
        arv,
      });
    });

    // Add Redfin listings
    // estimatedArv = individual estimate
    sourceListings.redfin?.listings.forEach((listing: any) => {
      const arv = calculateArv(listing.price, listing.estimate);
      listings.push({
        id: listing.id,
        address: listing.address || 'N/A',
        price: listing.price,
        url: listing.url,
        source: 'redfin',
        estimate: listing.estimate,
        estimatedArv: listing.estimate,
        arv,
      });
    });

    // Add Realtor listings
    // estimatedArv = individual estimate
    sourceListings.realtor?.listings.forEach((listing: any) => {
      const arv = calculateArv(listing.price, listing.estimate);
      listings.push({
        id: listing.id,
        address: listing.address || 'N/A',
        price: listing.price,
        url: listing.url,
        source: 'realtor',
        estimate: listing.estimate,
        estimatedArv: listing.estimate,
        arv,
      });
    });

    // Add Propwire listings
    // estimatedArv = individual estimate
    sourceListings.propwire?.listings.forEach((listing: any) => {
      const arv = calculateArv(listing.price, listing.estimate);
      listings.push({
        id: listing.id,
        address: listing.address || 'N/A',
        price: listing.price,
        url: listing.url,
        source: 'propwire',
        estimate: listing.estimate,
        estimatedArv: listing.estimate,
        arv,
      });
    });

    return listings;
  }, [properties, sourceListings]);

  const handleRefresh = async () => {
    await refetch();
    setSourceLoading(true);
    setSourceError(null);
    try {
      const [zillowData, redfinData, realtorData, propwireData] = await Promise.all([
        getZillowListings(1000),
        getRedfinListings(1000),
        getRealtorListings(1000),
        getPropwireListings(1000),
      ]);
      setSourceListings({
        zillow: zillowData,
        redfin: redfinData,
        realtor: realtorData,
        propwire: propwireData,
      });
    } catch (err) {
      setSourceError(err instanceof Error ? err : new Error('Failed to fetch source listings'));
    } finally {
      setSourceLoading(false);
    }
  };

  const getSourceBadgeColor = (source: string) => {
    switch (source) {
      case 'zillow':
        return 'bg-yellow-100 text-yellow-800';
      case 'redfin':
        return 'bg-red-100 text-red-800';
      case 'realtor':
        return 'bg-blue-100 text-blue-800';
      case 'propwire':
        return 'bg-purple-100 text-purple-800';
      default:
        return 'bg-gray-100 text-gray-800';
    }
  };

  return (
    <PageContainer>
      <Header
        title="All Listings"
        subtitle="Unified view of all listings with address, price, source, estimate, estimated ARV, ARV, and URL"
      />

      <div className="p-8">
        <div className="mb-6 flex gap-4 flex-wrap items-center">
          <button
            onClick={handleRefresh}
            disabled={loading || sourceLoading}
            className="px-4 py-2 bg-indigo-600 text-white rounded-lg hover:bg-indigo-700 transition-colors disabled:opacity-50 disabled:cursor-not-allowed font-medium flex items-center gap-2"
          >
            {loading || sourceLoading ? (
              <>
                <span className="inline-block h-4 w-4 border-2 border-white border-t-transparent rounded-full animate-spin"></span>
                Refreshing...
              </>
            ) : (
              <>
                <span>🔄</span>
                Refresh Data
              </>
            )}
          </button>
          <ExportButton 
            data={unifiedListings} 
            filename="all-listings" 
            dataType="properties"
            disabled={loading || sourceLoading}
          />
        </div>

        {(error || sourceError) && (
          <div className="bg-red-50 border border-red-200 text-red-800 px-4 py-3 rounded mb-4">
            {error && <p>Properties Error: {error.message}</p>}
            {sourceError && <p>Source Listings Error: {sourceError.message}</p>}
          </div>
        )}

        {loading || sourceLoading ? (
          <div className="text-center py-12">
            <p className="text-gray-500">Loading listings...</p>
          </div>
        ) : (
          <div>
            {unifiedListings.length === 0 ? (
              <div className="text-center py-12 bg-gray-50 rounded">
                <p className="text-gray-500">No listings found</p>
              </div>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full border-collapse">
                  <thead>
                    <tr className="bg-gray-100 border-b-2 border-gray-300">
                      <th className="px-4 py-3 text-left font-semibold text-gray-900">Address</th>
                      <th className="px-4 py-3 text-left font-semibold text-gray-900">Price</th>
                      <th className="px-4 py-3 text-left font-semibold text-gray-900">Source</th>
                      <th className="px-4 py-3 text-left font-semibold text-gray-900">Estimate</th>
                      <th className="px-4 py-3 text-left font-semibold text-gray-900">Estimated ARV</th>
                      <th className="px-4 py-3 text-left font-semibold text-gray-900">ARV</th>
                      <th className="px-4 py-3 text-left font-semibold text-gray-900">URL</th>
                    </tr>
                  </thead>
                  <tbody>
                    {unifiedListings.map((listing) => (
                      <tr
                        key={listing.id}
                        className="border-b border-gray-200 hover:bg-gray-50 transition-colors"
                      >
                        <td className="px-4 py-3 text-sm text-gray-900 font-medium max-w-xs truncate">
                          {listing.address}
                        </td>
                        <td className="px-4 py-3 text-sm text-gray-600">
                          {listing.price ? `$${listing.price.toLocaleString()}` : 'N/A'}
                        </td>
                        <td className="px-4 py-3">
                          <span className={`px-3 py-1 rounded-full text-xs font-semibold capitalize ${getSourceBadgeColor(listing.source)}`}>
                            {listing.source}
                          </span>
                        </td>
                        <td className="px-4 py-3 text-sm text-gray-600 font-medium">
                          {listing.estimate ? `$${listing.estimate.toLocaleString()}` : 'N/A'}
                        </td>
                        <td className="px-4 py-3 text-sm text-gray-600 font-medium">
                          {listing.estimatedArv ? `$${listing.estimatedArv.toLocaleString()}` : 'N/A'}
                        </td>
                        <td className="px-4 py-3 text-sm text-gray-600 font-medium">
                          {listing.arv !== undefined ? listing.arv.toFixed(2) : 'N/A'}
                        </td>
                        <td className="px-4 py-3 text-sm">
                          {listing.url ? (
                            <a
                              href={listing.url}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="text-blue-600 hover:text-blue-800 hover:underline truncate max-w-xs inline-block"
                              title={listing.url}
                            >
                              {listing.url.length > 40
                                ? `${listing.url.substring(0, 40)}...`
                                : listing.url}
                            </a>
                          ) : (
                            <span className="text-gray-400">N/A</span>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}

            <div className="mt-6 p-4 bg-gray-50 rounded border border-gray-200">
              <h3 className="font-semibold text-gray-900 mb-3">Summary</h3>
              <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
                <div>
                  <p className="text-xs text-gray-600">Total Listings</p>
                  <p className="text-2xl font-bold text-gray-900">{unifiedListings.length}</p>
                </div>
                <div>
                  <p className="text-xs text-gray-600">Zillow</p>
                  <p className="text-2xl font-bold text-yellow-700">
                    {unifiedListings.filter((l) => l.source === 'zillow').length}
                  </p>
                </div>
                <div>
                  <p className="text-xs text-gray-600">Redfin</p>
                  <p className="text-2xl font-bold text-red-700">
                    {unifiedListings.filter((l) => l.source === 'redfin').length}
                  </p>
                </div>
                <div>
                  <p className="text-xs text-gray-600">Realtor</p>
                  <p className="text-2xl font-bold text-blue-700">
                    {unifiedListings.filter((l) => l.source === 'realtor').length}
                  </p>
                </div>
                <div className="md:col-span-1">
                  <p className="text-xs text-gray-600">Propwire</p>
                  <p className="text-2xl font-bold text-purple-700">
                    {unifiedListings.filter((l) => l.source === 'propwire').length}
                  </p>
                </div>
              </div>
            </div>
          </div>
        )}
      </div>
    </PageContainer>
  );
};

export default PropertiesPage;
