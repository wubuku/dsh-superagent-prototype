#!/usr/bin/env node
/**
 * Read-only WCAG contrast check for edge and marker tokens in superagent-management.html.
 *
 * This reads the declared CSS tokens of each diagram preview layer (light and dark),
 * not rendered pixels. It catches what browser-check misses: the renderer's default
 * strokes can sit below 4.5:1 against the preview background, and browser-check only
 * checks font size and readability, not foreground/background contrast.
 *
 * Values resolve last-wins across all style blocks, so the local edge-contrast patch
 * inserted before `</body>` is what gets measured. The patch itself must be present.
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const html = readFileSync(join(root, 'superagent-management.html'), 'utf8')
const threshold = 4.5

// Informational strokes and fills the reader must distinguish. Decorative borders
// (panel-border, grid, canvas-dot) are excluded: they carry no information.
const tokens = ['arrow', 'arrow-emphasis', 'database-stroke', 'security-stroke', 'text', 'text-muted']
const read = [...tokens, 'bg']
const previews = ['preview-assembly-map', 'preview-event-flow-diagram', 'preview-thread-lifecycle-diagram']

const lum = (hex) => {
  let h = hex.replace('#', '')
  if (h.length === 3) h = h.split('').map((c) => c + c).join('')
  const ch = [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16) / 255)
    .map((c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4))
  return 0.2126 * ch[0] + 0.7152 * ch[1] + 0.0722 * ch[2]
}
const ratio = (a, b) => {
  const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p)
  return (x + 0.05) / (y + 0.05)
}

if (!html.includes('data-archify-patch="edge-contrast"')) {
  console.error('FAIL: edge contrast patch is missing; run tools/apply-edge-contrast.mjs after finalize')
  process.exit(1)
}

// Collect every `<style>` body in document order so later declarations win.
const styles = [...html.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/g)].map((m) => m[1])

const effective = (preview, theme) => {
  const out = {}
  const sel = theme === 'light'
    ? [`\\.${preview}\\[data-theme="light"\\]`, `\\.${preview}:not\\(\\[data-theme\\]\\)`]
    : [`\\.${preview}\\[data-theme="dark"\\]`, `\\.${preview},\\s*\\.${preview}\\[data-theme="dark"\\]`]
  for (const body of styles) {
    for (const pattern of sel) {
      const re = new RegExp(`(?:^|[,}\\s])(?:[^{}]*,\\s*)?${pattern}[^{]*\\{([^}]*)\\}`, 'g')
      let m
      while ((m = re.exec(body))) {
        for (const t of read) {
          const v = new RegExp(`--${t}:\\s*(#[0-9a-fA-F]{3,8})`).exec(m[1])
          if (v) out[t] = v[1]
        }
      }
    }
  }
  return out
}

const failures = []
for (const preview of previews) {
  for (const theme of ['light', 'dark']) {
    const vals = effective(preview, theme)
    const bg = vals.bg
    if (!bg) continue
    for (const t of tokens) {
      const fg = vals[t]
      if (!fg) continue
      const r = ratio(bg, fg)
      const line = `${preview} ${theme} ${t} ${fg} on ${bg} = ${r.toFixed(2)}:1`
      if (r < threshold) failures.push(line)
      else console.log(`ok   ${line}`)
    }
  }
}

if (failures.length) {
  for (const f of failures) console.error(`LOW  ${f}`)
  console.error(`\nFAIL: ${failures.length} token pair(s) below ${threshold}:1`)
  process.exit(1)
}
console.log(`\nPASS: every informational token meets ${threshold}:1 in both themes`)
