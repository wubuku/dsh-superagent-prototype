#!/usr/bin/env node
/** Inline the local lifecycle contrast patch into the generated explainer and sync its delivery receipt. */
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const htmlPath = join(root, 'dsh-superagent.html')
const receiptPath = join(root, 'dsh-superagent.delivery.json')
const patchPath = join(root, 'patches/lifecycle-contrast.css')
const start = '<!-- archify-patch:lifecycle-contrast:start -->'
const end = '<!-- archify-patch:lifecycle-contrast:end -->'

const css = readFileSync(patchPath, 'utf8').trim()
let html = readFileSync(htmlPath, 'utf8')

const previousStart = html.indexOf(start)
const previousEnd = html.indexOf(end)
if (previousStart >= 0 && previousEnd > previousStart) {
  html = html.slice(0, previousStart) + html.slice(previousEnd + end.length)
}

if (!html.includes('</head>')) throw new Error('dsh-superagent.html has no </head>')
const block = `${start}\n<style data-archify-patch="lifecycle-contrast">\n${css}\n</style>\n${end}\n`
html = html.replace('</head>', `${block}</head>`)
writeFileSync(htmlPath, html)

const bytes = statSync(htmlPath).size
const sha256 = createHash('sha256').update(readFileSync(htmlPath)).digest('hex')

if (existsSync(receiptPath)) {
  const receipt = JSON.parse(readFileSync(receiptPath, 'utf8'))
  receipt.artifact = { sha256, bytes }
  writeFileSync(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`)
  console.log(`receipt synced: ${receiptPath}`)
} else {
  console.log('receipt not found; artifact hash was not synced')
}

console.log(`applied: ${patchPath}`)
console.log(`artifact: ${bytes} bytes, sha256 ${sha256}`)
