import { Outlet } from 'react-router-dom';
import { Sidebar } from '../src/components/layout';
import './App.css';

function App() {
  return (
    <div className="flex h-screen bg-gray-50">
      <Sidebar />
      <Outlet />
    </div>
  );
}

export default App;
