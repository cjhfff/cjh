import type { WsClientMessage, WsServerEnvelope } from '@shared/schemas'

export interface DaemonConnectionInfo {
  port: number
  token: string
  dataDir: string
  mode: 'portable' | 'appdata' | 'custom'
  appExe: string
  version: string
}

let cachedConn: DaemonConnectionInfo | null = null

export async function getDaemonConnection(): Promise<DaemonConnectionInfo> {
  if (cachedConn) return cachedConn
  if (window.cjhShell) {
    const info = await window.cjhShell.getDaemonInfo()
    cachedConn = info
    return info
  }
  // Browser dev fallback via URL params ?port=...&token=...
  const params = new URLSearchParams(window.location.search)
  const port = Number(params.get('port') || '54812')
  const token = params.get('token') || ''
  cachedConn = {
    port,
    token,
    dataDir: '',
    mode: 'appdata',
    appExe: '',
    version: '0.1.0'
  }
  return cachedConn
}

export async function apiFetch<T = any>(path: string, init?: RequestInit): Promise<T> {
  const conn = await getDaemonConnection()
  const headers = new Headers(init?.headers || {})
  headers.set('Authorization', `Bearer ${conn.token}`)
  if (!(init?.body instanceof FormData) && !headers.has('Content-Type')) {
    headers.set('Content-Type', 'application/json')
  }

  const res = await fetch(`http://127.0.0.1:${conn.port}${path}`, {
    ...init,
    headers
  })
  if (!res.ok) {
    const errBody = await res.json().catch(() => ({ error: res.statusText }))
    throw new Error(errBody.error || `HTTP ${res.status}`)
  }
  return res.json() as Promise<T>
}

export async function uploadAttachmentFile(file: File, threadId?: string | null) {
  const form = new FormData()
  form.append('file', file)
  if (threadId) form.append('threadId', threadId)
  return apiFetch<{
    id: string
    fileName: string
    mimeType: string
    byteSize: number
  }>('/api/attachments', {
    method: 'POST',
    body: form
  })
}

export class DaemonWsClient {
  private ws: WebSocket | null = null
  private reconnectTimer: number | null = null
  private disposed = false

  constructor(private onEvent: (evt: WsServerEnvelope) => void) {}

  async connect(): Promise<void> {
    if (this.disposed) return
    const conn = await getDaemonConnection()
    const url = `ws://127.0.0.1:${conn.port}/ws?token=${encodeURIComponent(conn.token)}`
    const ws = new WebSocket(url)
    this.ws = ws

    ws.onmessage = ev => {
      try {
        const parsed = JSON.parse(String(ev.data)) as WsServerEnvelope
        this.onEvent(parsed)
      } catch {
        // Ignore malformed frame
      }
    }

    ws.onclose = () => {
      if (this.disposed) return
      this.reconnectTimer = window.setTimeout(() => {
        void this.connect()
      }, 1500)
    }
  }

  send(msg: WsClientMessage): void {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(msg))
    }
  }

  dispose(): void {
    this.disposed = true
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer)
    this.ws?.close()
  }
}
