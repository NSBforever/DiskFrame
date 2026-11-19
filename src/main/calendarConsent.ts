/**
 * Which drives Google Calendar matching may look at.
 *
 * Not every connected drive holds the calendar owner's photos - a family HDD
 * or a friend's SSD is someone else's memories. Matching only reads files on a
 * volume the user has explicitly allowed. Keyed by volume id, never by letter:
 * a different drive given the same letter has no answer of its own, so it is
 * excluded. Matching itself stays on this machine either way; nothing about a
 * file is ever sent to Google.
 *
 * Pure SQL over the passed connection (better-sqlite3 in the app, node:sqlite in tests).
 */
export interface ConsentDb {
  exec(sql: string): void
  prepare(sql: string): { run(...p: unknown[]): unknown; get(...p: unknown[]): unknown; all(...p: unknown[]): unknown[] }
}

export const CONSENT_SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS calendar_drive_consent (
    volume_id TEXT PRIMARY KEY,
    allowed INTEGER NOT NULL,
    decided_at TEXT NOT NULL
  );
`

/**
 * Creates the table. The first time only, a drive the user had already matched
 * photos on (it has their own Calendar decisions, 1.4.0) is allowed, so an
 * upgrade does not silently empty Events they built by hand. Nothing else is
 * granted, then or later.
 */
export function ensureConsentSchema(db: ConsentDb, now: Date): void {
  const existed = !!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'calendar_drive_consent'").get()
  db.exec(CONSENT_SCHEMA_SQL)
  if (existed) return
  const hasLinks = !!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'event_file_links'").get()
  if (!hasLinks) return
  db.prepare(
    `INSERT OR IGNORE INTO calendar_drive_consent (volume_id, allowed, decided_at)
     SELECT DISTINCT volume_id, 1, ? FROM event_file_links WHERE volume_id IS NOT NULL`
  ).run(now.toISOString())
}

export function isMatchingAllowed(db: ConsentDb, volumeId: string | null): boolean {
  if (!volumeId) return false
  const row = db.prepare('SELECT allowed FROM calendar_drive_consent WHERE volume_id = ?').get(volumeId) as { allowed: number } | undefined
  return row?.allowed === 1
}

export function setMatchingAllowed(db: ConsentDb, volumeId: string, allowed: boolean, now: Date): void {
  db.prepare(
    `INSERT INTO calendar_drive_consent (volume_id, allowed, decided_at) VALUES (?, ?, ?)
     ON CONFLICT (volume_id) DO UPDATE SET allowed = excluded.allowed, decided_at = excluded.decided_at`
  ).run(volumeId, allowed ? 1 : 0, now.toISOString())
}

export function consentList(db: ConsentDb): { volumeId: string; allowed: boolean; decidedAt: string }[] {
  return (
    db.prepare('SELECT volume_id, allowed, decided_at FROM calendar_drive_consent ORDER BY volume_id').all() as {
      volume_id: string
      allowed: number
      decided_at: string
    }[]
  ).map((r) => ({ volumeId: r.volume_id, allowed: r.allowed === 1, decidedAt: r.decided_at }))
}
