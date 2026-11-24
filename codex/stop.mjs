#!/usr/bin/env node
// Codex Stop hook: prints {"systemMessage": "<vocab card>"} for the user, or nothing.
// It never blocks the turn and never adds model context; on any error it prints nothing and exits 0.
import { fileURLToPath } from 'node:url'

const HARD_STOP_MS = 40_000

async function readStdin(limit = 4_000_000) {
  let data = ''
  for await (const chunk of process.stdin) {
    data += chunk
    if (data.length > limit) return null
  }
  return data
}

async function main() {
  if (process.env.OSMOSIS_CHILD === '1') return
  const raw = await readStdin()
  const input = raw ? JSON.parse(raw) : null
  if (!input || (input.hook_event_name && input.hook_event_name !== 'Stop')) return
  const lib = await import('./lib.mjs')
  if (lib.isChildRun(input, process.env)) return
  const dataDir = lib.dataDirFor(process.env, fileURLToPath(import.meta.url))
  const card = await lib.runStop(input, { env: process.env, dataDir, deadline: Date.now() + lib.DEADLINE_MS })
  if (card) process.stdout.write(`${JSON.stringify({ systemMessage: card })}\n`)
}

setTimeout(() => process.exit(0), HARD_STOP_MS).unref()
main()
  .catch(() => undefined)
  .finally(() => {
    process.exitCode = 0
  })
