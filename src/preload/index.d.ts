import type { DashboardApi } from './index.js'

declare global {
  interface Window {
    api: DashboardApi
  }
}

export {}
