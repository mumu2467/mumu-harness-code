/**
 * Generate the application icon as a 512x512 PNG.
 *
 * Written by hand with zlib rather than an image library so the repository
 * needs no binary art assets and no native build tooling: electron-builder
 * derives the platform-specific .ico and .icns files from this PNG.
 *
 * Usage: node scripts/make-icon.mjs
 */

import { deflateSync } from 'node:zlib'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const SIZE = 1024
const SS = 3 // supersampling factor per axis, for antialiased edges

const here = dirname(fileURLToPath(import.meta.url))
const outputDirectory = join(here, '..', 'build')
const outputFile = join(outputDirectory, 'icon.png')

/** Palette: a deep navy tile with a bright wave mark. */
const BACKGROUND_TOP = [23, 34, 54]
const BACKGROUND_BOTTOM = [12, 17, 26]
const ACCENT = [93, 160, 255]
const ACCENT_DIM = [56, 104, 186]

/**
 * Signed distance to a rounded rectangle centred in the canvas.
 * @param {number} x - Sample x.
 * @param {number} y - Sample y.
 * @param {number} halfWidth - Half width.
 * @param {number} halfHeight - Half height.
 * @param {number} radius - Corner radius.
 * @returns {number} Negative inside, positive outside.
 */
function roundedRectDistance (x, y, halfWidth, halfHeight, radius) {
  const dx = Math.abs(x) - (halfWidth - radius)
  const dy = Math.abs(y) - (halfHeight - radius)
  const outsideX = Math.max(dx, 0)
  const outsideY = Math.max(dy, 0)
  return Math.hypot(outsideX, outsideY) + Math.min(Math.max(dx, dy), 0) - radius
}

/**
 * Coverage of the tile shape at a normalized point.
 * @param {number} u - Normalized x in [-1, 1].
 * @param {number} v - Normalized y in [-1, 1].
 * @returns {number} Coverage in [0, 1].
 */
function tileCoverage (u, v) {
  return roundedRectDistance(u, v, 0.96, 0.96, 0.34) <= 0 ? 1 : 0
}

/**
 * Coverage of the wave mark.
 *
 * The mark is a stroked cubic sweep plus a dot: a body curve, a crest, and an
 * eye-like accent, drawn with distance fields so it scales cleanly.
 * @param {number} u - Normalized x in [-1, 1].
 * @param {number} v - Normalized y in [-1, 1].
 * @returns {number} Coverage in [0, 1].
 */
function markCoverage (u, v) {
  // Body: a shallow S sweep across the tile.
  const bodyY = -0.10 + 0.30 * Math.sin((u + 0.85) * 1.55) - 0.16 * Math.cos((u + 0.2) * 2.9)
  const body = Math.abs(v - bodyY) - 0.075

  // Crest: a ridge that rises to the right of the body.
  const crestY = -0.42 + 0.55 * Math.max(0, u + 0.15) ** 1.4
  const crest = Math.abs(v - crestY) - 0.062

  // Restrict each stroke to its own horizontal span.
  const bodyStroke = (u > -0.78 && u < 0.86) ? body : 1
  const crestStroke = (u > -0.10 && u < 0.70) ? crest : 1
  const strokes = Math.min(bodyStroke, crestStroke)

  // Eye dot.
  const dot = Math.hypot(u - 0.55, v - 0.20) - 0.085

  return strokes <= 0 || dot <= 0 ? 1 : 0
}

/**
 * Blend two colours.
 * @param {number[]} a - First colour.
 * @param {number[]} b - Second colour.
 * @param {number} ratio - Weight of `b`.
 * @returns {number[]} Blended colour.
 */
function mix (a, b, ratio) {
  return [
    a[0] + (b[0] - a[0]) * ratio,
    a[1] + (b[1] - a[1]) * ratio,
    a[2] + (b[2] - a[2]) * ratio
  ]
}

/** Render the icon into an RGBA buffer. */
function render () {
  const pixels = Buffer.alloc(SIZE * SIZE * 4)
  const samples = SS * SS

  for (let y = 0; y < SIZE; y += 1) {
    for (let x = 0; x < SIZE; x += 1) {
      let tile = 0
      let mark = 0
      for (let sy = 0; sy < SS; sy += 1) {
        for (let sx = 0; sx < SS; sx += 1) {
          const px = x + (sx + 0.5) / SS
          const py = y + (sy + 0.5) / SS
          const u = (px / SIZE) * 2 - 1
          const v = (py / SIZE) * 2 - 1
          tile += tileCoverage(u, v)
          mark += markCoverage(u, v)
        }
      }
      tile /= samples
      mark /= samples

      // Vertical gradient provides depth behind the mark.
      const vertical = y / (SIZE - 1)
      let colour = mix(BACKGROUND_TOP, BACKGROUND_BOTTOM, vertical)
      if (mark > 0) colour = mix(colour, mix(ACCENT_DIM, ACCENT, vertical * 0.8 + 0.2), mark)

      const offset = (y * SIZE + x) * 4
      pixels[offset] = Math.round(colour[0])
      pixels[offset + 1] = Math.round(colour[1])
      pixels[offset + 2] = Math.round(colour[2])
      pixels[offset + 3] = Math.round(tile * 255)
    }
  }
  return pixels
}

/**
 * Wrap raw scanlines in the PNG container.
 * @param {Buffer} raw - Raw RGBA pixels.
 * @returns {Buffer} Complete PNG file.
 */
function encodePng (raw) {
  const stride = SIZE * 4
  const filtered = Buffer.alloc((stride + 1) * SIZE)
  for (let y = 0; y < SIZE; y += 1) {
    filtered[y * (stride + 1)] = 0 // filter type: none
    raw.copy(filtered, y * (stride + 1) + 1, y * stride, (y + 1) * stride)
  }

  const chunk = (type, data) => {
    const length = Buffer.alloc(4)
    length.writeUInt32BE(data.length, 0)
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
    const crc = Buffer.alloc(4)
    crc.writeUInt32BE(crc32(body) >>> 0, 0)
    return Buffer.concat([length, body, crc])
  }

  const header = Buffer.alloc(13)
  header.writeUInt32BE(SIZE, 0)
  header.writeUInt32BE(SIZE, 4)
  header[8] = 8 // bit depth
  header[9] = 6 // colour type: RGBA
  header[10] = 0
  header[11] = 0
  header[12] = 0

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(filtered, { level: 9 })),
    chunk('IEND', Buffer.alloc(0))
  ])
}

/** CRC-32 as required by the PNG specification. */
const CRC_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let n = 0; n < 256; n += 1) {
    let c = n
    for (let k = 0; k < 8; k += 1) c = (c & 1) !== 0 ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1)
    table[n] = c >>> 0
  }
  return table
})()

/**
 * Compute a PNG chunk CRC.
 * @param {Buffer} buffer - Chunk type and data.
 * @returns {number} CRC value.
 */
function crc32 (buffer) {
  let crc = 0xffffffff
  for (const byte of buffer) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8)
  return (crc ^ 0xffffffff) >>> 0
}

mkdirSync(outputDirectory, { recursive: true })
writeFileSync(outputFile, encodePng(render()))
process.stdout.write(`wrote ${outputFile} (${String(SIZE)}x${String(SIZE)})\n`)
