import React, { useState } from 'react';
import type { Listing } from '@/services';
import { ListingRow } from './ListingRow';
import { ListingDrawer } from './ListingDrawer';

interface ListingsTableProps {
  listings: Listing[];
  loading?: boolean;
}

export const ListingsTable: React.FC<ListingsTableProps> = ({ listings, loading = false }) => {
  const [selectedListing, setSelectedListing] = useState<Listing | null>(null);

  if (loading) {
    return (
      <div className="text-center py-12">
        <p className="text-gray-500">Loading listings...</p>
      </div>
    );
  }

  if (listings.length === 0) {
    return (
      <div className="text-center py-12">
        <p className="text-gray-500">No listings found</p>
      </div>
    );
  }

  return (
    <>
      <div className="overflow-x-auto">
        <div className="min-w-full max-h-[640px] overflow-y-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left border-b bg-gray-100">
                <th className="px-4 py-3 font-semibold text-gray-700">Address</th>
                <th className="px-4 py-3 font-semibold text-gray-700">Price</th>
                <th className="px-4 py-3 font-semibold text-gray-700">Source</th>
                <th className="px-4 py-3 font-semibold text-gray-700">URL</th>
              </tr>
            </thead>
            <tbody>
              {listings.map((listing) => (
                <ListingRow
                  key={listing.id}
                  listing={listing}
                  onClick={() => setSelectedListing(listing)}
                />
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {selectedListing && (
        <ListingDrawer
          listing={selectedListing}
          onClose={() => setSelectedListing(null)}
        />
      )}
    </>
  );
};
