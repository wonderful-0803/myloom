'use strict'
const fs = require('node:fs')
const YAML = require('yaml')

function document(file) {
  try {
    if (!fs.existsSync(file)) return new YAML.Document({ version: 1, refs: {} })
    if (!fs.lstatSync(file).isFile() || fs.statSync(file).size > 1024 * 1024) throw new Error()
    const value = YAML.parseDocument(fs.readFileSync(file, 'utf8'), { schema: 'core', prettyErrors: false, uniqueKeys: true })
    if (value.errors.length || !YAML.isMap(value.contents) || value.get('version') !== 1) throw new Error()
    value.toJS({ maxAliasCount: 0 })
    return value
  } catch { throw new Error('无法读取本机模型凭据，请重新连接模型。') }
}
function readModelKey(file) {
  const value = document(file).getIn(['refs', 'LOOM_MODEL_API_KEY'])
  if (typeof value !== 'string' || value.length < 8 || value.length > 8192 || /[\s\x00]/.test(value)) throw new Error('未读取到已保存的模型 API Key，请重新连接模型。')
  return value
}
function modelKeyDocument(file, key) {
  const value = document(file)
  value.setIn(['refs', 'LOOM_MODEL_API_KEY'], key)
  return value.toString()
}
module.exports = { readModelKey, modelKeyDocument }
