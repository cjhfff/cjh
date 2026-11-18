import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'

const PREFIX = 'enc:v1:'

export class SecretVault {
  private key: Buffer

  constructor(masterKeyHex?: string, fallbackKeyPath?: string) {
    if (masterKeyHex && /^[0-9a-fA-F]{64}$/.test(masterKeyHex)) {
      this.key = Buffer.from(masterKeyHex, 'hex')
      return
    }
    if (fallbackKeyPath) {
      if (existsSync(fallbackKeyPath)) {
        const raw = readFileSync(fallbackKeyPath, 'utf8').trim()
        if (/^[0-9a-fA-F]{64}$/.test(raw)) {
          this.key = Buffer.from(raw, 'hex')
          return
        }
      }
      const generated = randomBytes(32)
      writeFileSync(fallbackKeyPath, generated.toString('hex'), { mode: 0o600 })
      this.key = generated
      return
    }
    this.key = randomBytes(32)
  }

  encrypt(plain: string): string {
    const iv = randomBytes(12)
    const cipher = createCipheriv('aes-256-gcm', this.key, iv)
    const encrypted = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()])
    const authTag = cipher.getAuthTag()
    return `${PREFIX}${iv.toString('hex')}:${authTag.toString('hex')}:${encrypted.toString('hex')}`
  }

  decrypt(stored: string | null | undefined): string | null {
    if (!stored) return null
    if (!stored.startsWith(PREFIX)) return stored
    const parts = stored.slice(PREFIX.length).split(':')
    if (parts.length !== 3) return null
    try {
      const [ivHex, tagHex, cipherHex] = parts
      const decipher = createDecipheriv('aes-256-gcm', this.key, Buffer.from(ivHex, 'hex'))
      decipher.setAuthTag(Buffer.from(tagHex, 'hex'))
      const decrypted = Buffer.concat([
        decipher.update(Buffer.from(cipherHex, 'hex')),
        decipher.final()
      ])
      return decrypted.toString('utf8')
    } catch {
      return null
    }
  }

  static mask(plain: string | null | undefined): string | null {
    if (!plain) return null
    if (plain.length <= 8) return '••••••••'
    return `${plain.slice(0, 4)}••••${plain.slice(-4)}`
  }
}
