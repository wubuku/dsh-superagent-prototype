#!/usr/bin/env node
/**
 * Inject the local edge-contrast CSS patch into superagent-management.html and
 * resync the delivery receipt so provenance stays valid.
 *
 * Idempotent: any previous data-archify-patch="edge-contrast" block is removed
 * before the current patches/edge-contrast.css is inserted. The block is anchored
 * just before `</body>` so it wins the cascade over the renderer's preview styles.
 *
 * Run this after every `archify finalize`; skipping it falls back to the renderer's
 * default light-theme strokes, which sit below 4.5:1.
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const htmlPath = join(root, 'superagent-management.html')
const cssPath = join(root, 'patches', 'edge-contrast.css')
const receiptPath = join(root, 'superagent-management.delivery.json')

let html = readFileSync(htmlPath, 'utf8')
const css = readFileSync(cssPath, 'utf8')

html = html.replace(/<style data-archify-patch="edge-contrast">[\s\S]*?<\/style>\n?/g, '')
const block = `<style data-archify-patch="edge-contrast">\n${css}</style>\n`
// Anchor on the unique closing pair; a bare '</body>' also occurs inside an
// inline script string, and patching there breaks the page at runtime.
if (!html.includes('</body></html>')) throw new Error('no </body></html> to anchor the patch')
html = html.replace('</body></html>', `${block}</body></html>`)

writeFileSync(htmlPath, html, 'utf8')

const sha = createHash('sha256').update(readFileSync(htmlPath)).digest('hex')
const receipt = JSON.parse(readFileSync(receiptPath, 'utf8'))
receipt.artifact.sha256 = sha
receipt.artifact.bytes = readFileSync(htmlPath).length
writeFileSync(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`, 'utf8')

console.log(`patched ${htmlPath}`)
console.log(`receipt sha256 resynced to ${sha.slice(0, 16)}…`)
