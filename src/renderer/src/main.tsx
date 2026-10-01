import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App.js'
// The wordmark's font, bundled so the title bar renders the same offline. Latin, one weight only.
import '@fontsource/unbounded/latin-600.css'
import './index.css'

createRoot(document.getElementById('root') as HTMLElement).render(
  <StrictMode>
    <App />
  </StrictMode>
)
