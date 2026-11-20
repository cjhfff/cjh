#!/usr/bin/env node
/**
 * Optional real-machine smoke script for herdr-core (NOT part of npm test).
 * Safety: Creates a single scratch terminal tagged with `cjh-test=1` and
 * only invokes read / label / kill / rm on that specific terminal address.
 */
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { createInterface } from 'node:readline'

function findHerdrBinary() {
  if (process.env.HERDR_EXEC_PATH && existsSync(process.env.HERDR_EXEC_PATH)) {
    return process.env.HERDR_EXEC_PATH
  }
  const winDefault = join(
    process.env.LOCALAPPDATA || join(homedir(), 'AppData', 'Local'),
    'Programs',
    'herdr-core',
    'herdr-core.exe'
  )
  if (process.platform === 'win32' && existsSync(winDefault)) {
    return winDefault
  }
  return 'herdr-core'
}

class SimpleHerdrRpc {
  constructor(binPath) {
    this.child = spawn(binPath, ['connect'], {
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true
    })
    this.nextId = 1
    this.pending = new Map()
    this.rl = createInterface({ input: this.child.stdout })
    this.rl.on('line', line => {
      const trimmed = line.trim()
      if (!trimmed) return
      const msg = JSON.parse(trimmed)
      if (msg.id !== undefined && this.pending.has(msg.id)) {
        const p = this.pending.get(msg.id)
        this.pending.delete(msg.id)
        if (msg.error) p.reject(new Error(msg.error.message || JSON.stringify(msg.error)))
        else p.resolve(msg.result)
      }
    })
  }

  call(method, params = {}) {
    const id = this.nextId++
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`RPC timeout: ${method}`))
      }, 15_000)
      this.pending.set(id, {
        resolve: v => {
          clearTimeout(timer)
          resolve(v)
        },
        reject: err => {
          clearTimeout(timer)
          reject(err)
        }
      })
      this.child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n')
    })
  }

  close() {
    this.rl.close()
    this.child.kill()
  }
}

async function main() {
  const bin = findHerdrBinary()
  console.log(`[herdr-smoke] using binary: ${bin}`)
  const rpc = new SimpleHerdrRpc(bin)
  let createdAddress = null

  try {
    const hello = await rpc.call('hello', { generation: 1, framed: false })
    console.log(`[herdr-smoke] hello ok: v${hello.version} core=${hello.core?.name}`)

    const status = await rpc.call('server.status')
    console.log(`[herdr-smoke] status: live=${status.live} finished=${status.finished}`)

    const runRes = await rpc.call('terminal.run', {
      argv: [process.execPath, '-e', 'console.log("cjh-smoke-ok"); setTimeout(() => {}, 5000)'],
      labels: { 'cjh-test': '1' },
      wait: false
    })
    createdAddress = runRes.address
    console.log(`[herdr-smoke] created scratch terminal: ${createdAddress}`)

    await new Promise(r => setTimeout(r, 400))
    const readRes = await rpc.call('terminal.read', { terminal: createdAddress, lines: 20 })
    console.log(`[herdr-smoke] read how=${readRes.how}, textLen=${readRes.text.length}`)

    const labelRes = await rpc.call('terminal.label', {
      terminal: createdAddress,
      labels: { 'cjh-smoke': 'verified' }
    })
    console.log(`[herdr-smoke] label updated:`, labelRes.labels)
  } finally {
    if (createdAddress) {
      try {
        await rpc.call('terminal.kill', { terminal: createdAddress })
      } catch (err) {
        console.warn(`[herdr-smoke] kill warning:`, err.message)
      }
      try {
        await rpc.call('terminal.rm', { terminal: createdAddress })
        console.log(`[herdr-smoke] cleaned up ${createdAddress}`)
      } catch (err) {
        console.warn(`[herdr-smoke] rm warning:`, err.message)
      }
    }
    rpc.close()
  }
}

main().catch(err => {
  console.error('[herdr-smoke] failed:', err)
  process.exit(1)
})
