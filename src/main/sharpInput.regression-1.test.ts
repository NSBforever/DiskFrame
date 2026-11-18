// Regression: 1.3.0 closed outright when a thumbnail source sat on a bad
// sector. sharp(path) lets libvips memory-map the file, and a failed page-in
// is an EXCEPTION_IN_PAGE_ERROR that kills the main process; no try/catch
// sees it. Every sharp() call in the main process must get bytes, never a path.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

const dir = join(import.meta.dirname, '.')

test('main process never hands sharp a file path', () => {
  const offenders: string[] = []
  for (const name of readdirSync(dir)) {
    if (!name.endsWith('.ts') || name.endsWith('.test.ts')) continue
    readFileSync(join(dir, name), 'utf8')
      .split('\n')
      .forEach((line, i) => {
        if (/^\s*(\/\/|\*|\/\*)/.test(line)) return
        // Allowed inputs: Buffer.from(...), an awaited readFile(...), a
        // previous sharp output buffer named data, or a { create } spec.
        for (const m of line.matchAll(/\bsharp\(\s*([^)]*)/g)) {
          const arg = m[1].trim()
          if (/^(Buffer\.from|await fs\.promises\.readFile|data\b|\{)/.test(arg)) continue
          offenders.push(`${name}:${i + 1}: ${line.trim()}`)
        }
      })
  }
  assert.deepEqual(offenders, [])
})
