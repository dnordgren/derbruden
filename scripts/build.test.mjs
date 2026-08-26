import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { resolveIncludes } from './build.mjs'

function withFixture(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'derbruden-build-'))
  try {
    return fn(dir)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

test('expands nested includes and substitutes attributes', () => {
  withFixture(dir => {
    mkdirSync(join(dir, 'partials'), { recursive: true })
    writeFileSync(join(dir, 'partials', 'inner.html'), '<p>{{name}}</p>')
    writeFileSync(
      join(dir, 'partials', 'outer.html'),
      '<div><!--#include file="partials/inner.html" name="{{who}}" --></div>'
    )
    const page = '<main><!--#include file="partials/outer.html" who="DN" --></main>'
    assert.equal(resolveIncludes(page, [], dir), '<main><div><p>DN</p></div></main>')
  })
})

test('leaves unknown placeholders untouched', () => {
  withFixture(dir => {
    writeFileSync(join(dir, 'p.html'), '<p>{{mystery}}</p>')
    const page = '<main><!--#include file="p.html" --></main>'
    assert.equal(resolveIncludes(page, [], dir), '<main><p>{{mystery}}</p></main>')
  })
})

test('rejects an include without a file attribute', () => {
  assert.throws(() => resolveIncludes('<!--#include title="x" -->'), /file attribute/)
})

test('rejects a missing partial', () => {
  withFixture(dir => {
    assert.throws(() => resolveIncludes('<!--#include file="nope.html" -->', [], dir), /not found/)
  })
})

test('rejects circular includes', () => {
  withFixture(dir => {
    writeFileSync(join(dir, 'a.html'), '<!--#include file="b.html" -->')
    writeFileSync(join(dir, 'b.html'), '<!--#include file="a.html" -->')
    assert.throws(() => resolveIncludes('<!--#include file="a.html" -->', [], dir), /Circular/)
  })
})
