/// <reference types="vite/client" />
import type { CjhShellBridge } from '../../preload/index'

declare global {
  interface Window {
    cjhShell?: CjhShellBridge
  }
}
