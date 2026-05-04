import React from 'react'
import ReactDOM from 'react-dom/client'
import { BrowserRouter, Routes, Route } from 'react-router-dom'
import App from './App.tsx'
import { ListingsPage, PropertiesPage, FiltersPage } from '@/pages'
import './index.css'

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <BrowserRouter>
      <Routes>
        <Route element={<App />}>
          <Route path="/" element={<ListingsPage />} />
          <Route path="/properties" element={<PropertiesPage />} />
          <Route path="/filters" element={<FiltersPage />} />
        </Route>
      </Routes>
    </BrowserRouter>
  </React.StrictMode>,
)
