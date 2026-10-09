import { useEffect, useRef } from 'react'

/**
 * ⌘↵ (Ctrl+Enter off macOS) runs `onSubmit` while mounted and enabled. The latest callback is
 * always the one called, so a caller can pass an inline function without re-subscribing.
 */
export function useSubmitShortcut(onSubmit: (() => void) | undefined, enabled = true): void {
  const latest = useRef(onSubmit)
  useEffect(() => {
    latest.current = onSubmit
  })
  const active = enabled && Boolean(onSubmit)
  useEffect(() => {
    if (!active) return
    function onKeyDown(event: KeyboardEvent): void {
      if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
        event.preventDefault()
        latest.current?.()
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [active])
}
