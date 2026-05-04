import React from 'react';
import { Card } from '../common';
import type { Listing } from '../../services';

interface ListingDrawerProps {
  listing: Listing;
  onClose: () => void;
}

export const ListingDrawer: React.FC<ListingDrawerProps> = ({ listing, onClose }) => {
  const formatCurrency = (value?: number) => {
    if (!value) return 'N/A';
    return `$${value.toLocaleString()}`;
  };

  return (
    <>
      {/* Overlay */}
      <div
        className="fixed inset-0 bg-black bg-opacity-50 z-40"
        onClick={onClose}
      />

      {/* Drawer */}
      <div className="fixed right-0 top-0 h-full w-96 bg-white shadow-lg z-50 overflow-y-auto">
        <div className="p-6">
          <div className="flex justify-between items-start mb-6">
            <h2 className="text-2xl font-bold text-gray-900">Listing Details</h2>
            <button
              onClick={onClose}
              className="text-gray-500 hover:text-gray-700 text-2xl leading-none"
            >
              ✕
            </button>
          </div>

          <Card className="mb-6">
            <h3 className="text-lg font-semibold mb-4 text-gray-900">
              {listing.rawAddress || listing.location || 'N/A'}
            </h3>

            <div className="space-y-4">
              <div>
                <p className="text-sm text-gray-600">Price</p>
                <p className="text-xl font-bold text-gray-900">{formatCurrency(listing.price)}</p>
              </div>

              <div>
                <p className="text-sm text-gray-600">Location</p>
                <p className="text-gray-900">{listing.location || 'N/A'}</p>
              </div>

              <div>
                <p className="text-sm text-gray-600">Property Type</p>
                <p className="text-gray-900">{listing.propertyType || 'N/A'}</p>
              </div>

              <div className="grid grid-cols-2 gap-4">
                <div>
                  <p className="text-sm text-gray-600">Bedrooms</p>
                  <p className="text-gray-900">{listing.bedrooms || 'N/A'}</p>
                </div>
                <div>
                  <p className="text-sm text-gray-600">Bathrooms</p>
                  <p className="text-gray-900">{listing.bathrooms || 'N/A'}</p>
                </div>
              </div>

              <div>
                <p className="text-sm text-gray-600">Square Feet</p>
                <p className="text-gray-900">{listing.squareFeet?.toLocaleString() || 'N/A'}</p>
              </div>

              <div>
                <p className="text-sm text-gray-600">Equity Estimate</p>
                <p className="text-lg font-bold text-green-700">
                  {formatCurrency(listing.equityEstimate)}
                </p>
              </div>

              <div>
                <p className="text-sm text-gray-600">Deal Score</p>
                <p className="text-gray-900">{listing.dealScore || 'N/A'}</p>
              </div>

              <div>
                <p className="text-sm text-gray-600">Source</p>
                <p className="text-gray-900 font-medium">{listing.source}</p>
              </div>
            </div>
          </Card>

          {listing.description && (
            <Card>
              <h4 className="font-semibold text-gray-900 mb-2">Description</h4>
              <p className="text-gray-700 text-sm leading-relaxed">{listing.description}</p>
            </Card>
          )}

          {listing.url && (
            <div className="mt-6">
              <a
                href={listing.url}
                target="_blank"
                rel="noopener noreferrer"
                className="block w-full bg-indigo-600 text-white text-center py-2 rounded hover:bg-indigo-700 transition-colors font-medium"
              >
                View on {listing.source}
              </a>
            </div>
          )}
        </div>
      </div>
    </>
  );
};
