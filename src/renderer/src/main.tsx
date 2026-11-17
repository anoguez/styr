import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { setPrimaryModifier } from '@core/shortcuts.js'
import App from './App.js'
import { DetachedTerminal } from './components/DetachedTerminal.js'
import { detachedSessionId } from './lib/detachedWindow.js'
import { IS_MAC } from './lib/platform.js'
// The wordmark's font, bundled so the title bar renders the same offline. Latin, one weight only.
import '@fontsource/unbounded/latin-600.css'
import './index.css'

// Before the first render, so every shortcut label and key match uses the platform's modifier.
setPrimaryModifier(IS_MAC ? 'meta' : 'ctrl')

// A detached terminal's window loads the same page with `#detached=<id>` and draws only that tab.
const detached = detachedSessionId(window.location.hash)

createRoot(document.getElementById('root') as HTMLElement).render(
  <StrictMode>{detached ? <DetachedTerminal sessionId={detached} /> : <App />}</StrictMode>
)
