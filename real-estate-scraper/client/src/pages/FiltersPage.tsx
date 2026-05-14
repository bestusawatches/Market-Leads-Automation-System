import React, { useState } from 'react';
import { Header, PageContainer } from '@/components/layout';
import { FilterForm } from '@/components/filters';
import { useFilter } from '@/hooks';

export const FiltersPage: React.FC = () => {
  const { filter, loading, error, updateFilter } = useFilter();
  const [isSaving, setIsSaving] = useState(false);

  const handleSubmit = async (filterData: any) => {
    setIsSaving(true);
    try {
      await updateFilter(filterData);
    } finally {
      setIsSaving(false);
    }
  };

  const isbusy = isSaving || loading;

  return (
    <PageContainer>
      <Header
        title="Filters"
        subtitle="Configure your active search filter"
      />

      <div className="px-8 py-6 space-y-5">

        {/* Error */}
        {error && (
          <div className="flex items-start gap-3 bg-red-50 border border-red-100 text-red-700 px-4 py-3 rounded-xl text-sm">
            <svg className="h-4 w-4 mt-0.5 shrink-0" viewBox="0 0 16 16" fill="currentColor">
              <path d="M8 1a7 7 0 1 0 0 14A7 7 0 0 0 8 1zm0 10.5a.75.75 0 1 1 0-1.5.75.75 0 0 1 0 1.5zm.75-3.75a.75.75 0 0 1-1.5 0V5a.75.75 0 0 1 1.5 0v2.75z"/>
            </svg>
            <p>{error.message}</p>
          </div>
        )}

        {/* Saving banner */}
        {isSaving && (
          <div className="flex items-center gap-2 text-sm text-slate-500 bg-slate-50 border border-slate-200 px-4 py-2.5 rounded-xl">
            <span className="h-3.5 w-3.5 border-2 border-slate-300 border-t-slate-600 rounded-full animate-spin" />
            Saving filter…
          </div>
        )}

        {/* Form card */}
        <div className="bg-white border border-slate-200 rounded-2xl shadow-sm p-6">
          <FilterForm
            initialFilter={filter}
            onSubmit={handleSubmit}
            loading={isbusy}
          />
        </div>

      </div>
    </PageContainer>
  );
};
