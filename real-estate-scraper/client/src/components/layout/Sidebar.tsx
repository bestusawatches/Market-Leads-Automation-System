import React from 'react';
import { Link, useLocation } from 'react-router-dom';

export const Sidebar: React.FC = () => {
  const location = useLocation();

  const navItems = [
    { label: 'Listings', path: '/', icon: '📋' },
    { label: 'Properties', path: '/properties', icon: '🏠' },
    { label: 'Filters', path: '/filters', icon: '⚙️' },
  ];

  return (
    <aside className="w-64 bg-indigo-900 text-white h-screen shadow-lg">
      <div className="p-6">
        <h1 className="text-2xl font-bold">Real Estate</h1>
        <p className="text-indigo-300 text-sm">Market Leads</p>
      </div>

      <nav className="mt-8">
        {navItems.map((item) => (
          <Link
            key={item.path}
            to={item.path}
            className={`flex items-center gap-3 px-6 py-3 text-left hover:bg-indigo-800 transition-colors ${
              location.pathname === item.path ? 'bg-indigo-700 border-l-4 border-indigo-400' : ''
            }`}
          >
            <span className="text-xl">{item.icon}</span>
            <span>{item.label}</span>
          </Link>
        ))}
      </nav>
    </aside>
  );
};
