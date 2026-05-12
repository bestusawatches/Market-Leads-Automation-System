import React from 'react';
import { Badge } from '../common';
import type { Listing } from '../../services';

interface ListingRowProps {
  listing: Listing;
  onClick: () => void;
}

export const ListingRow: React.FC<ListingRowProps> = ({ listing, onClick }) => {
  const formatCurrency = (value?: number) => {
    if (value === undefined || value === null) return 'N/A';
    return `$${value.toLocaleString()}`;
  };

  const truncateUrl = (url: string, maxLength: number = 40) => {
    if (url.length <= maxLength) return url;
    return url.substring(0, maxLength) + '...';
  };

  return (
    <tr
      onClick={onClick}
      className="border-b hover:bg-gray-50 cursor-pointer transition-colors"
    >
      <td className="px-4 py-3 font-medium text-gray-900">
        {listing.rawAddress || listing.location || 'N/A'}
      </td>
      <td className="px-4 py-3">{formatCurrency(listing.price)}</td>
      <td className="px-4 py-3">
        <Badge value={listing.source} variant="info" />
      </td>
      <td className="px-4 py-3 text-sm text-gray-600">
        {listing.createdAt ? new Date(listing.createdAt).toLocaleString() : 'N/A'}
      </td>
      <td className="px-4 py-3">
        {listing.url ? (
          <a
            href={listing.url}
            target="_blank"
            rel="noopener noreferrer"
            onClick={(e) => e.stopPropagation()}
            title={listing.url}
            className="text-blue-600 hover:text-blue-800 hover:underline truncate inline-block max-w-xs"
          >
            {truncateUrl(listing.url)}
          </a>
        ) : (
          'N/A'
        )}
      </td>
    </tr>
  );
};
