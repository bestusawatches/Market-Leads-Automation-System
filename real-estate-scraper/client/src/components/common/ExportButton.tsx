import React, { useState } from 'react';
import { exportToCSV, exportToJSON } from '@/services/api';

interface ExportButtonProps {
  data: any[];
  filename: string;
  dataType?: 'listings' | 'properties';
  disabled?: boolean;
}

export const ExportButton: React.FC<ExportButtonProps> = ({
  data,
  filename,
  dataType = 'listings',
  disabled = false,
}) => {
  const [isOpen, setIsOpen] = useState(false);
  const [exporting, setExporting] = useState(false);

  const handleExport = (format: 'csv' | 'json') => {
    try {
      setExporting(true);
      const timestamp = new Date().toISOString().split('T')[0];
      const fullFilename = `${filename}-${timestamp}.${format}`;

      if (format === 'csv') {
        exportToCSV(data, fullFilename);
      } else {
        exportToJSON(data, fullFilename);
      }

      setIsOpen(false);
    } catch (error) {
      console.error('Export failed:', error);
      alert('Failed to export data');
    } finally {
      setExporting(false);
    }
  };

  return (
    <div className="relative">
      <button
        onClick={() => setIsOpen(!isOpen)}
        disabled={disabled || data.length === 0 || exporting}
        className="px-4 py-2 bg-green-600 text-white rounded-lg hover:bg-green-700 transition-colors disabled:opacity-50 disabled:cursor-not-allowed font-medium flex items-center gap-2"
      >
        {exporting ? (
          <>
            <span className="inline-block h-4 w-4 border-2 border-white border-t-transparent rounded-full animate-spin"></span>
            Exporting...
          </>
        ) : (
          <>
            <span>📥</span>
            Export
          </>
        )}
      </button>

      {isOpen && (
        <div className="absolute right-0 mt-2 w-48 bg-white rounded-lg shadow-lg z-50 border border-gray-200">
          <button
            onClick={() => handleExport('csv')}
            disabled={exporting}
            className="w-full text-left px-4 py-2 hover:bg-gray-100 disabled:opacity-50 disabled:cursor-not-allowed first:rounded-t-lg flex items-center gap-2 transition-colors"
          >
            <span>📊</span>
            Export as CSV
          </button>
          <button
            onClick={() => handleExport('json')}
            disabled={exporting}
            className="w-full text-left px-4 py-2 hover:bg-gray-100 disabled:opacity-50 disabled:cursor-not-allowed last:rounded-b-lg flex items-center gap-2 transition-colors border-t border-gray-200"
          >
            <span>{ }</span>
            Export as JSON
          </button>
          <div className="px-4 py-2 text-xs text-gray-500 bg-gray-50 rounded-b-lg">
            {data.length} {dataType}
          </div>
        </div>
      )}
    </div>
  );
};
