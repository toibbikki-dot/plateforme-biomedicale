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

// Application installable (PWA)
// Le navigateur propose l'installation via l'événement « beforeinstallprompt » :
// on le garde de côté pour l'utiliser avec le bouton « Installer l'application ».
window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault()
  window.__bmInstallation = e
  window.dispatchEvent(new Event('bm-installation-dispo'))
})
// Enregistrement du programme de démarrage
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => { navigator.serviceWorker.register('/sw.js').catch(() => {}) })
}
