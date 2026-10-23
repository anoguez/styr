import { useEffect, useState } from 'react'

/**
 * macOS native full screen hides the traffic lights, and the window then fills the screen
 * (a zoomed window still leaves the menu bar). Electron has no renderer-side flag for it, so this
 * compares the window with the screen on every resize.
 */
export function isWindowFullscreen(): boolean {
  return window.outerWidth >= screen.width && window.outerHeight >= screen.height
}

export function useFullscreen(): boolean {
  const [full, setFull] = useState(isWindowFullscreen)
  useEffect(() => {
    const update = (): void => setFull(isWindowFullscreen())
    window.addEventListener('resize', update)
    return () => window.removeEventListener('resize', update)
  }, [])
  return full
}
