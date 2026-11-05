#!/usr/bin/env node
/**
 * Read-only WCAG contrast check for the lifecycle dashed edges in dsh-superagent.html.
 *
 * This reads declared CSS tokens (the local patch and the lifecycle preview --bg),
 * not rendered pixels. It catches the regression that browser-check misses: the
 * preview layer resets dashed/security strokes to --rule-strong, and browser-check
 * only checks font size/readability, not foreground/background contrast.
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const html = readFileSync(join(root, 'dsh-superagent.html'), 'utf8')
const threshold = 4.5

const patch = html.match(/<style data-archify-patch="lifecycle-contrast">([\s\S]*?)<\/style>/)
if (!patch) {
  console.error('FAIL: lifecycle contrast patch is missing; run tools/apply-lifecycle-contrast.mjs after finalize')
  process.exit(1)
}

const base = /\.board \.diagram-preview\.preview-ticket-lifecycle-diagram\[class\]\s*\{([^}]*)\}/.exec(patch[1])
const light = /\.board \.diagram-preview\.preview-ticket-lifecycle-diagram\[class\]\[data-theme="light"\]\s*\{([^}]*)\}/.exec(patch[1])
if (!base || !light) {
  console.error('FAIL: could not parse the lifecycle contrast patch rules')
  process.exit(1)
}

const blockAt = (selector) => {
  const selectorAt = html.indexOf(selector)
  if (selectorAt < 0) return null
  const open = html.indexOf('{', selectorAt)
  const close = html.indexOf('}', open)
  return open >= 0 && close > open ? html.slice(open + 1, close) : null
}
const darkPalette = blockAt('.preview-ticket-lifecycle-diagram,.preview-ticket-lifecycle-diagram[data-theme="dark"]{')
const lightPalette = blockAt('.preview-ticket-lifecycle-diagram[data-theme="light"]{')
if (!darkPalette || !lightPalette) {
  console.error('FAIL: could not find the lifecycle preview --bg colors')
  process.exit(1)
}

const token = (block, name) => {
  const match = block.match(new RegExp(`--${name}\\s*:\\s*(#[0-9a-fA-F]{3,6})`))
  return match?.[1]
}
const hexToRgb = (hex) => {
  const value = hex.length === 4
    ? hex.slice(1).split('').map(char => char + char).join('')
    : hex.slice(1)
  return [0, 2, 4].map(index => parseInt(value.slice(index, index + 2), 16) / 255)
}
const luminance = (hex) => {
  const [r, g, b] = hexToRgb(hex).map(value => value <= 0.03928
    ? value / 12.92
    : Math.pow((value + 0.055) / 1.055, 2.4))
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}
const contrast = (foreground, background) => {
  const [a, b] = [luminance(foreground), luminance(background)].sort((x, y) => y - x)
  return (a + 0.05) / (b + 0.05)
}

const rows = [
  ['light', 'optional/reversal', token(light[1], 'database-stroke'), token(lightPalette, 'bg')],
  ['light', 'security', token(light[1], 'security-stroke'), token(lightPalette, 'bg')],
  ['dark', 'optional/reversal', token(base[1], 'database-stroke'), token(darkPalette, 'bg')],
  ['dark', 'security', token(base[1], 'security-stroke'), token(darkPalette, 'bg')],
].map(([theme, kind, foreground, background]) => {
  const ratio = foreground && background ? contrast(foreground, background) : NaN
  return { theme, kind, foreground, background, ratio, pass: ratio >= threshold }
})

let ok = true
for (const row of rows) {
  const verdict = row.pass ? 'PASS' : 'FAIL'
  if (!row.pass) ok = false
  const ratio = Number.isFinite(row.ratio) ? row.ratio.toFixed(2) : 'n/a'
  console.log(`${verdict} ${row.theme.padEnd(5)} ${row.kind.padEnd(18)} ${row.foreground} on ${row.background} = ${ratio}:1`)
}

console.log(`\nthreshold: ${threshold}:1 | source: declared CSS tokens, not rendered pixels`)
console.log('limitation: this does not measure anti-aliased strokes or local panel backgrounds; browser-check still has no contrast check')
process.exit(ok ? 0 : 1)
