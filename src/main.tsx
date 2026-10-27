import { createRoot } from 'react-dom/client';
import { App } from './ui/App.tsx';
import 'leaflet/dist/leaflet.css';
import './style.css';
import './app.css';

createRoot(document.getElementById('app')!).render(<App />);
