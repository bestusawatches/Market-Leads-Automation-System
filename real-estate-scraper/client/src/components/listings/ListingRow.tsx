import React from 'react';
import { Badge } from '../common';
import type { Listing } from '../../services';

interface ListingRowProps {
  listing: Listing;
  onClick: () => void;
}

export const ListingRow: React.FC<ListingRowProps> = ({ listing, onClick }) => {
  const formatCurrency = (value?: number) => {
    if (!value) return 'N/A';
    return `$${value.toLocaleString()}`;
  };

  const equity = listing.equityEstimate ? `$${listing.equityEstimate.toLocaleString()}` : 'N/A';

  return (
    <tr
      onClick={onClick}
      className="border-b hover:bg-gray-50 cursor-pointer transition-colors"
    >
      <td className="px-4 py-3 font-medium text-gray-900">
        {listing.rawAddress || listing.location || 'N/A'}
      </td>
      <td className="px-4 py-3">{formatCurrency(listing.price)}</td>
      <td className="px-4 py-3">{formatCurrency(listing.price)}</td>
      <td className="px-4 py-3 font-semibold text-green-700">{equity}</td>
      <td className="px-4 py-3">
        {listing.dealScore ? (
          <Badge
            value={listing.dealScore}
            variant={
              listing.dealScore === 'A'
                ? 'success'
                : listing.dealScore === 'B'
                  ? 'info'
                  : listing.dealScore === 'C'
                    ? 'warning'
                    : 'danger'
            }
          />
        ) : (
          'N/A'
        )}
      </td>
      <td className="px-4 py-3">
        <Badge value={listing.source} variant="info" />
      </td>
    </tr>
  );
};
