import { test } from 'node:test'
import assert from 'node:assert/strict'
import { cellCountOf, cellSpan, mediaCountOf, COMPACT_PER_CELL } from './compactCells.ts'

test('a group with no documents is unchanged, one cell per file', () => {
  for (const n of [0, 1, 2, 3, 4, 5, 37]) {
    const g = { count: n, compactCount: 0 }
    assert.equal(cellCountOf(g), n, `count ${n}`)
    for (let i = 0; i < n; i++) {
      assert.deepEqual(cellSpan(g, i), { start: i, count: 1 })
    }
  }
})

test('groups of 1 to 5 documents pack into the right number of cells', () => {
  const expected = [0, 1, 1, 1, 1, 2]
  for (let n = 0; n <= 5; n++) {
    assert.equal(cellCountOf({ count: n, compactCount: n }), expected[n], `${n} documents`)
  }
})

test('every file in a document group is reachable from exactly one cell', () => {
  for (let n = 1; n <= 13; n++) {
    const g = { count: n, compactCount: n }
    const seen = new Set<number>()
    for (let cell = 0; cell < cellCountOf(g); cell++) {
      const span = cellSpan(g, cell)
      assert.ok(span.count > 0, `cell ${cell} of ${n} is empty`)
      for (let k = 0; k < span.count; k++) {
        const row = span.start + k
        assert.ok(!seen.has(row), `row ${row} appears twice for n=${n}`)
        assert.ok(row < n, `row ${row} is past the end for n=${n}`)
        seen.add(row)
      }
    }
    assert.equal(seen.size, n, `n=${n} covered ${seen.size}`)
  }
})

test('the last cell of an uneven group is short, not padded', () => {
  const g = { count: 5, compactCount: 5 }
  assert.deepEqual(cellSpan(g, 0), { start: 0, count: 4 })
  assert.deepEqual(cellSpan(g, 1), { start: 4, count: 1 })
})

test('mixed groups put the documents after the previewable files', () => {
  // 3 photos and 5 documents: three full tiles, then two compact cells.
  const g = { count: 8, compactCount: 5 }
  assert.equal(mediaCountOf(g), 3)
  assert.equal(cellCountOf(g), 5)
  assert.deepEqual(cellSpan(g, 0), { start: 0, count: 1 })
  assert.deepEqual(cellSpan(g, 2), { start: 2, count: 1 })
  assert.deepEqual(cellSpan(g, 3), { start: 3, count: 4 })
  assert.deepEqual(cellSpan(g, 4), { start: 7, count: 1 })
})

test('every file of a mixed group is covered exactly once', () => {
  for (let total = 1; total <= 12; total++) {
    for (let docs = 0; docs <= total; docs++) {
      const g = { count: total, compactCount: docs }
      const seen = new Set<number>()
      for (let cell = 0; cell < cellCountOf(g); cell++) {
        const span = cellSpan(g, cell)
        for (let k = 0; k < span.count; k++) seen.add(span.start + k)
      }
      assert.equal(seen.size, total, `total=${total} docs=${docs}`)
    }
  }
})

test('a compact count larger than the group is clamped rather than trusted', () => {
  const g = { count: 3, compactCount: 99 }
  assert.equal(mediaCountOf(g), 0)
  assert.equal(cellCountOf(g), 1)
  assert.deepEqual(cellSpan(g, 0), { start: 0, count: 3 })
})

test('a missing compact count behaves as no documents', () => {
  const g = { count: 4, compactCount: Number.NaN }
  assert.equal(mediaCountOf(g), 4)
  assert.equal(cellCountOf(g), 4)
})

test('packing never loses a file at a page boundary', () => {
  // A group straddling the 200-row page size must still map cleanly.
  const g = { count: 250, compactCount: 250 }
  assert.equal(cellCountOf(g), Math.ceil(250 / COMPACT_PER_CELL))
  const last = cellSpan(g, cellCountOf(g) - 1)
  assert.equal(last.start + last.count, 250)
})
