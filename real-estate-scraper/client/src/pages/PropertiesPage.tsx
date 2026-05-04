import React from 'react';
import { Header, PageContainer } from '@/components/layout';
import { Card } from '@/components/common';
import { useProperties } from '@/hooks';

export const PropertiesPage: React.FC = () => {
  const { properties, loading, error, refetch } = useProperties();

  return (
    <PageContainer>
      <Header
        title="Properties"
        subtitle="View all properties with their related listings and estimates"
      />

      <div className="p-8">
        <div className="mb-6 flex gap-4">
          <button
            onClick={refetch}
            disabled={loading}
            className="px-4 py-2 bg-indigo-600 text-white rounded-lg hover:bg-indigo-700 transition-colors disabled:opacity-50 font-medium"
          >
            {loading ? 'Refreshing...' : 'Refresh Properties'}
          </button>
        </div>

        {error && (
          <div className="bg-red-50 border border-red-200 text-red-800 px-4 py-3 rounded mb-4">
            Error: {error.message}
          </div>
        )}

        {loading ? (
          <div className="text-center py-12">
            <p className="text-gray-500">Loading properties...</p>
          </div>
        ) : (
          <div className="space-y-6">
            {properties.length === 0 ? (
              <div className="text-center py-12">
                <p className="text-gray-500">No properties found</p>
              </div>
            ) : (
              properties.map((property) => (
                <Card key={property.id}>
                  <div className="mb-4">
                    <h3 className="text-xl font-bold text-gray-900">
                      {property.address || property.normalizedAddress || 'N/A'}
                    </h3>
                    {property.city && property.state && (
                      <p className="text-gray-600">
                        {property.city}, {property.state} {property.zip}
                      </p>
                    )}
                    {property.latitude && property.longitude && (
                      <p className="text-sm text-gray-500">
                        {property.latitude}, {property.longitude}
                      </p>
                    )}
                  </div>

                  {property.listings.length > 0 && (
                    <div className="mb-4">
                      <h4 className="font-semibold text-gray-900 mb-2">Listings ({property.listings.length})</h4>
                      <div className="space-y-2">
                        {property.listings.slice(0, 3).map((listing) => (
                          <div key={listing.id} className="text-sm bg-gray-50 p-2 rounded">
                            <p className="font-medium">{listing.title || 'N/A'}</p>
                            <p className="text-gray-600">
                              ${listing.price?.toLocaleString()} · {listing.source} · {listing.bedrooms}bd {listing.bathrooms}ba
                            </p>
                          </div>
                        ))}
                        {property.listings.length > 3 && (
                          <p className="text-sm text-indigo-600">
                            +{property.listings.length - 3} more listings
                          </p>
                        )}
                      </div>
                    </div>
                  )}

                  {property.estimates.length > 0 && (
                    <div>
                      <h4 className="font-semibold text-gray-900 mb-2">Estimates ({property.estimates.length})</h4>
                      <div className="space-y-1">
                        {property.estimates.map((est) => (
                          <div key={est.id} className="text-sm flex justify-between">
                            <span className="text-gray-600">{est.source}</span>
                            <span className="font-medium">${est.value.toLocaleString()}</span>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}
                </Card>
              ))
            )}
          </div>
        )}

        <div className="mt-4 text-gray-600 text-sm">
          Showing {properties.length} properties
        </div>
      </div>
    </PageContainer>
  );
};
