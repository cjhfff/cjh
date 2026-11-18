import type { WebSocket } from 'ws'
import { WsServerEnvelope } from '@shared/schemas'

export class WsHub {
  private clients = new Set<WebSocket>()

  add(ws: WebSocket): void {
    this.clients.add(ws)
    ws.on('close', () => {
      this.clients.delete(ws)
    })
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
  }

  get clientCount(): number {
    return this.clients.size
  }
}
