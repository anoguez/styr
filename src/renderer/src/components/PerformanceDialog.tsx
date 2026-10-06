import { useEffect, useState, type ReactNode } from 'react'
import {
  formatDiagnostics,
  type DiagnosticsSnapshot,
  type RendererMetrics
} from '@core/diagnostics.js'
import { Button, Modal } from './ui.js'

const REFRESH_MS = 2000

/** `performance.memory` is Chromium-only and absent from the DOM typings. */
function heapMb(): number | undefined {
  const memory = (performance as unknown as { memory?: { usedJSHeapSize: number } }).memory
  return memory ? memory.usedJSHeapSize / 1024 / 1024 : undefined
}

/**
 * Samples only while open: the timer, the long-task observer and the main-process event-loop
 * histogram all stop on close, so the panel costs nothing when nobody is looking at it.
 */
export function PerformanceDialog({ onClose }: { onClose: () => void }): ReactNode {
  const [snapshot, setSnapshot] = useState<DiagnosticsSnapshot>()
  const [renderer, setRenderer] = useState<RendererMetrics>({ domNodes: 0, longTasks: 0 })
  const [copied, setCopied] = useState(false)

  useEffect(() => {
    let cancelled = false
    let longTasks = 0
    let observer: PerformanceObserver | undefined
    try {
      observer = new PerformanceObserver((list) => {
        longTasks += list.getEntries().length
      })
      observer.observe({ entryTypes: ['longtask'] })
    } catch {
      // not supported: the count stays 0
    }
    const sample = (): void => {
      void window.api.diagnostics.snapshot().then((next) => {
        if (cancelled) return
        setSnapshot(next)
        setRenderer({
          heapMb: heapMb(),
          domNodes: document.getElementsByTagName('*').length,
          longTasks
        })
      })
    }
    sample()
    const timer = window.setInterval(sample, REFRESH_MS)
    return () => {
      cancelled = true
      window.clearInterval(timer)
      observer?.disconnect()
      void window.api.diagnostics.stop()
    }
  }, [])

  const copy = (): void => {
    if (!snapshot) return
    void navigator.clipboard.writeText(formatDiagnostics(snapshot, renderer)).then(() => {
      setCopied(true)
      window.setTimeout(() => setCopied(false), 1500)
    })
  }

  return (
    <Modal
      title="Performance"
      subtitle={`Refreshes every ${REFRESH_MS / 1000}s while open. ${snapshot && !snapshot.packaged ? 'Dev build: numbers are higher than a packaged app.' : ''}`}
      onClose={onClose}
      footer={
        <>
          <Button onClick={copy} disabled={!snapshot}>
            {copied ? 'Copied' : 'Copy report'}
          </Button>
          <Button onClick={onClose}>Close</Button>
        </>
      }
    >
      {snapshot ? (
        <pre className="overflow-x-auto rounded-lg border border-edge-strong bg-chrome p-3 font-mono text-[11px] leading-relaxed text-ink">
          {formatDiagnostics(snapshot, renderer)}
        </pre>
      ) : (
        <p className="py-6 text-center text-[12px] text-faint">Sampling…</p>
      )}
    </Modal>
  )
}
