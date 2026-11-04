'use strict'
// Render the existing Loom grid mark without downloading or introducing a raster dependency.
const fs = require('node:fs')
const path = require('node:path')
const zlib = require('node:zlib')
function crc32(buffer) {
  let crc = 0xffffffff
  for (const byte of buffer) { crc ^= byte; for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0) }
  return (crc ^ 0xffffffff) >>> 0
}
function chunk(name, bytes) {
  const type = Buffer.from(name), length = Buffer.alloc(4), checksum = Buffer.alloc(4)
  length.writeUInt32BE(bytes.length); checksum.writeUInt32BE(crc32(Buffer.concat([type, bytes])))
  return Buffer.concat([length, type, bytes, checksum])
}
function buildIcon(destination, size = 256, template = false) {
  const rows = Buffer.alloc((size * 4 + 1) * size)
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const ux = (x + .5) / (size / 32), uy = (y + .5) / (size / 32), dx = Math.max(8 - ux, ux - 24, 0), dy = Math.max(8 - uy, uy - 24, 0)
    const visible = dx * dx + dy * dy < 64
    const line = ([10, 16, 22].some(n => Math.abs(ux - n) < .65) && uy >= 7 && uy <= 25)
      || ([11, 17, 23].some(n => Math.abs(uy - n) < .65) && ux >= 7 && ux <= 25) || (ux >= 16 && ux <= 22 && uy >= 11 && uy <= 17)
    const color = template ? [0, 0, 0] : line ? [241, 242, 232] : [45, 61, 48], offset = y * (size * 4 + 1) + 1 + x * 4
    color.forEach((byte, index) => { rows[offset + index] = byte }); rows[offset + 3] = (template ? line : visible) ? 255 : 0
  }
  const header = Buffer.alloc(13); header.writeUInt32BE(size); header.writeUInt32BE(size, 4); header[8] = 8; header[9] = 6
  fs.mkdirSync(path.dirname(destination), { recursive: true })
  fs.writeFileSync(destination, Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', header), chunk('IDAT', zlib.deflateSync(rows)), chunk('IEND', Buffer.alloc(0))]))
}
function buildMacIcons(directory) {
  fs.mkdirSync(directory, { recursive: true })
  buildIcon(path.join(directory, 'icon.png'))
  buildIcon(path.join(directory, 'trayTemplate.png'), 32, true)
  const entries = [[128, 'ic07'], [256, 'ic08'], [512, 'ic09'], [1024, 'ic10']].map(([size, type]) => {
    const file = path.join(directory, `icon-${size}.png`)
    buildIcon(file, size); const png = fs.readFileSync(file); fs.unlinkSync(file)
    const header = Buffer.alloc(8); header.write(type); header.writeUInt32BE(png.length + 8, 4)
    return Buffer.concat([header, png])
  })
  const header = Buffer.alloc(8); header.write('icns'); header.writeUInt32BE(8 + entries.reduce((size, entry) => size + entry.length, 0), 4)
  fs.writeFileSync(path.join(directory, 'icon.icns'), Buffer.concat([header, ...entries]))
}
if (require.main === module) {
  if (process.platform === 'darwin') buildMacIcons(path.resolve(__dirname, '../assets'))
  else buildIcon(path.resolve(__dirname, '../assets/icon.png'))
}
module.exports = { buildIcon, buildMacIcons }
