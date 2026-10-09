import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { setPrimaryModifier } from '@core/shortcuts.js'
import App from './App.js'
import { IS_MAC } from './lib/platform.js'
// The wordmark's font, bundled so the title bar renders the same offline. Latin, one weight only.
import '@fontsource/unbounded/latin-600.css'
import './index.css'

// Before the first render, so every shortcut label and key match uses the platform's modifier.
setPrimaryModifier(IS_MAC ? 'meta' : 'ctrl')

createRoot(document.getElementById('root') as HTMLElement).render(
  <StrictMode>
    <App />
  </StrictMode>
)
