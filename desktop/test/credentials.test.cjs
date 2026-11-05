'use strict'
const { test, afterEach } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs'), os = require('node:os'), path = require('node:path')
const YAML = require('yaml')
const { readModelKey, modelKeyDocument } = require('../credentials.cjs')
const roots = []
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }) })
function file(text) { const root = fs.mkdtempSync(path.join(os.tmpdir(), 'loom-key-')); roots.push(root); const name = path.join(root, 'credentials.yaml'); fs.writeFileSync(name, text); return name }
test('reloads a model key after Harness writes YAML records into a JSON-origin credential document', () => {
  const name = file('{\n "version": 1,\n "refs": { "LOOM_MODEL_API_KEY": "fixture-model-key" },\n records: { "provider": { kind: api-key, payload: fixture-record } }\n}\n')
  assert.throws(() => JSON.parse(fs.readFileSync(name, 'utf8')))
  assert.equal(readModelKey(name), 'fixture-model-key')
})
test('credential updates preserve unrelated references and Harness-managed records', () => {
  const name = file('version: 1\nrefs:\n  LOOM_MODEL_API_KEY: old-fixture-key\n  OTHER_REF: another-fixture-key\nrecords:\n  provider:\n    kind: api-key\n    payload: unrelated-record\n')
  const next = YAML.parse(modelKeyDocument(name, 'new-fixture-key'))
  assert.equal(next.refs.LOOM_MODEL_API_KEY, 'new-fixture-key'); assert.equal(next.refs.OTHER_REF, 'another-fixture-key')
  assert.deepEqual(next.records, { provider: { kind: 'api-key', payload: 'unrelated-record' } })
})
test('malformed and missing credentials fail locally without leaking their contents', () => {
  for (const content of ['version: 1\nrefs: {}\n', 'version: 1\nrefs: [SECRET_INPUT\n', 'version: 1\nrefs: {}\nrefs: {}\n']) {
    const name = file(content)
    assert.throws(() => readModelKey(name), error => error instanceof Error && !error.message.includes('SECRET_INPUT'))
  }
})
