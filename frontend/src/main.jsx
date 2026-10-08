import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import './themes.css'

// Thème mémorisé sur cet appareil (sombre par défaut)
try { document.documentElement.dataset.theme = localStorage.getItem('theme') || 'sombre' } catch { document.documentElement.dataset.theme = 'sombre' }
import App from './App.jsx'

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
