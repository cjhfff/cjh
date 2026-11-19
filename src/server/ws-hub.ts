import type { WebSocket } from 'ws'
import { WsServerEnvelope } from '@shared/schemas'

export class WsHub {
  private clients = new Set<WebSocket>()
  private listeners = new Set<(evt: WsServerEnvelope) => void>()

  add(ws: WebSocket): void {
    this.clients.add(ws)
    ws.on('close', () => {
      this.clients.delete(ws)
    })
  }

  subscribe(listener: (evt: WsServerEnvelope) => void): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  broadcast<T>(type: string, data: T): void {
    const payload: WsServerEnvelope<T> = {
      type,
      data,
      timestamp: Date.now()
    }
    const serialized = JSON.stringify(payload)
    for (const client of this.clients) {
      if (client.readyState === 1) {
        client.send(serialized)
      }
    }
    for (const listener of [...this.listeners]) {
      try {
        listener(payload)
      } catch {
        // Ignore internal listener errors
      }
    }
  }

  get clientCount(): number {
    return this.clients.size
  }
}
