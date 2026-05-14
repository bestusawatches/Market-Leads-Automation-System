import React, { useMemo } from 'react';
import { Header, PageContainer } from '@/components/layout';
import { ExportButton } from '@/components/common';
import { useProperties } from '@/hooks';

interface UnifiedListing {
  id: string;
  address: string;
  price?: number;
  url?: string;
  source: string;
  createdAt?: string;
  estimatedArv?: number;
  arv?: number;
  zillowEstimate?: number;
  redfinEstimate?: number;
  propwireEstimate?: number;
  realtorEstimate?: number;
}

const calculateMedian = (values: number[]): number | undefined => {
  if (values.length === 0) return undefined;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[mid - 1] + sorted[mid]) / 2
    : sorted[mid];
};

const calculateArv = (price?: number, estimatedArv?: number): number | undefined => {
  if (price === undefined || estimatedArv === undefined || estimatedArv === 0) return undefined;
  const percentage = ((price + 50000) / estimatedArv) * 100;
  return Math.round(percentage * 100) / 100;
};

const fmt = (n?: number) => (n ? `$${n.toLocaleString()}` : '—');

/* ── Column header component ─────────────────────────────────────── */
const Th: React.FC<{ children: React.ReactNode; className?: string }> = ({ children, className = '' }) => (
  <th
    className={`
      px-4 py-3 text-left text-[11px] font-semibold uppercase tracking-wider
      text-slate-400 whitespace-nowrap border-b border-slate-100
      ${className}
    `}
  >
    {children}
  </th>
);

/* ── Table cell ───────────────────────────────────────────────────── */
const Td: React.FC<{ children: React.ReactNode; className?: string }> = ({ children, className = '' }) => (
  <td className={`px-4 py-3 text-sm text-slate-600 border-b border-slate-50 ${className}`}>
    {children}
  </td>
);

export const PropertiesPage: React.FC = () => {
  const { properties, loading, error, refetch } = useProperties();

  const unifiedListings = useMemo(() => {
    const listings: UnifiedListing[] = [];

    properties.forEach((property) => {
      const estimatedArv = calculateMedian(property.estimates.map((e) => e.value));

      property.listings.forEach((listing) => {
        const arv = calculateArv(listing.price, estimatedArv);
        listings.push({
          id: listing.id,
          address: property.normalizedAddress || property.address || 'N/A',
          price: listing.price,
          url: listing.url,
          source: listing.source,
          createdAt: listing.createdAt,
          estimatedArv,
          arv,
          zillowEstimate: property.estimates.find((e) => e.source === 'zillow')?.value,
          redfinEstimate: property.estimates.find((e) => e.source === 'redfin')?.value,
          propwireEstimate: property.estimates.find((e) => e.source === 'propwire')?.value,
          realtorEstimate: property.estimates.find((e) => e.source === 'realtor')?.value,
        });
      });
    });

    return listings;
  }, [properties]);

  return (
    <PageContainer>
      <Header
        title="All Listings"
        subtitle="Unified view of property listings with ARV analysis"
      />

      <div className="px-8 py-6 space-y-6">

        {/* Action bar */}
        <div className="flex items-center gap-3 flex-wrap">
          <button
            onClick={refetch}
            disabled={loading}
            className="
              inline-flex items-center gap-2 px-4 py-2 text-sm font-medium
              bg-slate-900 text-white rounded-lg
              hover:bg-slate-700 active:scale-[0.98]
              disabled:opacity-40 disabled:cursor-not-allowed
              transition-all duration-150
            "
          >
            {loading ? (
              <>
                <span className="h-3.5 w-3.5 border-2 border-white/40 border-t-white rounded-full animate-spin" />
                Refreshing…
              </>
            ) : (
              <>
                <svg className="h-3.5 w-3.5" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8">
                  <path d="M13.5 8A5.5 5.5 0 1 1 8 2.5" strokeLinecap="round"/>
                  <path d="M8 1v4l2.5-2L8 1z" fill="currentColor" stroke="none"/>
                </svg>
                Refresh Data
              </>
            )}
          </button>

          <ExportButton
            data={unifiedListings}
            filename="all-listings"
            dataType="properties"
            disabled={loading}
          />
        </div>

        {/* Error */}
        {error && (
          <div className="flex items-start gap-3 bg-red-50 border border-red-100 text-red-700 px-4 py-3 rounded-xl text-sm">
            <svg className="h-4 w-4 mt-0.5 shrink-0" viewBox="0 0 16 16" fill="currentColor">
              <path d="M8 1a7 7 0 1 0 0 14A7 7 0 0 0 8 1zm0 10.5a.75.75 0 1 1 0-1.5.75.75 0 0 1 0 1.5zm.75-3.75a.75.75 0 0 1-1.5 0V5a.75.75 0 0 1 1.5 0v2.75z"/>
            </svg>
            <p>{error.message}</p>
          </div>
        )}

        {/* Content */}
        {loading ? (
          <div className="flex items-center justify-center py-20">
            <span className="h-6 w-6 border-2 border-slate-200 border-t-slate-500 rounded-full animate-spin" />
          </div>
        ) : unifiedListings.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-20 bg-white border border-slate-200 rounded-2xl">
            <div className="h-10 w-10 rounded-full bg-slate-100 flex items-center justify-center mb-4">
              <svg className="h-5 w-5 text-slate-400" viewBox="0 0 20 20" fill="currentColor">
                <path d="M10.707 2.293a1 1 0 0 0-1.414 0l-7 7a1 1 0 0 0 1.414 1.414L4 10.414V17a1 1 0 0 0 1 1h3a1 1 0 0 0 1-1v-2a1 1 0 0 1 1-1h2a1 1 0 0 1 1 1v2a1 1 0 0 0 1 1h3a1 1 0 0 0 1-1v-6.586l.293.293a1 1 0 0 0 1.414-1.414l-7-7z"/>
              </svg>
            </div>
            <p className="text-slate-700 font-medium">No listings found</p>
          </div>
        ) : (
          <div className="space-y-4">
            {/* Table */}
            <div className="bg-white border border-slate-200 rounded-2xl shadow-sm overflow-hidden">
              <div className="overflow-x-auto">
                <table className="w-full border-collapse min-w-[1100px]">
                  <thead className="bg-slate-50/80">
                    <tr>
                      <Th>Address</Th>
                      <Th>Price</Th>
                      <Th>Source</Th>
                      <Th>Date Scraped</Th>
                      <Th>Est. ARV</Th>
                      <Th>ARV %</Th>
                      <Th>Zillow</Th>
                      <Th>Redfin</Th>
                      <Th>Propwire</Th>
                      <Th>Realtor</Th>
                      <Th>URL</Th>
                    </tr>
                  </thead>
                  <tbody>
                    {unifiedListings.map((listing) => (
                      <tr
                        key={listing.id}
                        className="hover:bg-slate-50/60 transition-colors duration-100"
                      >
                        <Td className="font-medium text-slate-800 max-w-[180px] truncate">
                          {listing.address}
                        </Td>
                        <Td className="font-medium text-slate-800">{fmt(listing.price)}</Td>
                        <Td>
                          <span className="inline-flex px-2 py-0.5 rounded-md bg-slate-100 text-slate-600 text-xs font-medium capitalize">
                            {listing.source}
                          </span>
                        </Td>
                        <Td>
                          {listing.createdAt
                            ? new Date(listing.createdAt).toLocaleDateString(undefined, {
                                month: 'short',
                                day: 'numeric',
                                year: 'numeric',
                              })
                            : '—'}
                        </Td>
                        <Td>{fmt(listing.estimatedArv)}</Td>
                        <Td>
                          {listing.arv !== undefined ? (
                            <span
                              className={`font-semibold ${
                                listing.arv <= 70
                                  ? 'text-emerald-600'
                                  : listing.arv <= 85
                                  ? 'text-amber-500'
                                  : 'text-red-500'
                              }`}
                            >
                              {listing.arv.toFixed(2)}%
                            </span>
                          ) : (
                            '—'
                          )}
                        </Td>
                        <Td>{fmt(listing.zillowEstimate)}</Td>
                        <Td>{fmt(listing.redfinEstimate)}</Td>
                        <Td>{fmt(listing.propwireEstimate)}</Td>
                        <Td>{fmt(listing.realtorEstimate)}</Td>
                        <Td>
                          {listing.url ? (
                            <a
                              href={listing.url}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="text-slate-500 hover:text-slate-900 underline underline-offset-2 text-xs truncate max-w-[160px] inline-block transition-colors"
                              title={listing.url}
                            >
                              {listing.url.replace(/^https?:\/\//, '').substring(0, 36)}…
                            </a>
                          ) : (
                            <span className="text-slate-300">—</span>
                          )}
                        </Td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>

          </div>
        )}
      </div>
    </PageContainer>
  );
};

export default PropertiesPage;
