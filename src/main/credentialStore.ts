import * as fs from 'node:fs'

/** The parts of Electron's safeStorage used here (DPAPI on Windows). */
export interface Encryptor {
  isEncryptionAvailable(): boolean
  encryptString(plain: string): Buffer
  decryptString(encrypted: Buffer): string
}

/**
 * The Google refresh token, encrypted with the OS (Windows DPAPI: other users
 * of this PC cannot read it; programs running as this user can, which is the
 * OS's own boundary). Kept in its own file, never in diskframe.db (copied into
 * backups/) and never in a log. If the OS cannot encrypt, nothing is saved -
 * there is no plain-text fallback.
 */
export function credentialStore(file: string, enc: Encryptor): { save(token: string): void; load(): string | null; clear(): void } {
  return {
    save(token: string): void {
      if (!enc.isEncryptionAvailable()) throw new Error('This system cannot encrypt the sign-in, so it was not saved')
      const tmp = `${file}.${process.pid}.tmp`
      fs.writeFileSync(tmp, enc.encryptString(token), { mode: 0o600 })
      fs.renameSync(tmp, file)
    },
    load(): string | null {
      try {
        return enc.decryptString(fs.readFileSync(file))
      } catch {
        return null // missing, or unreadable by this user: treat as signed out
      }
    },
    clear(): void {
      fs.rmSync(file, { force: true })
    }
  }
}
