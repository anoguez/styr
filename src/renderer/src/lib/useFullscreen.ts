import { useEffect, useState } from 'react'

/** Whether the window is in native full screen, as the main process reports it. */
export function useFullscreen(): boolean {
  const [full, setFull] = useState(false)
  useEffect(() => window.api.app.onFullscreen(setFull), [])
  return full
}
