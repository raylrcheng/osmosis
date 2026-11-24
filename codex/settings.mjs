#!/usr/bin/env node
// Reads or changes the Codex vocab card settings. Run with "help" for the list.
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { HELP, applyCommand, dataDirFor, parseSettings, readJson, today, usageLine, writeJson } from './lib.mjs'

const dataDir = dataDirFor(process.env, fileURLToPath(import.meta.url))
const path = join(dataDir, 'settings.json')
const s = parseSettings(readJson(path, {}))
const r = applyCommand(s, process.argv.slice(2))

if (r.error) {
  console.error(r.error)
  process.exit(1)
}
if (r.message === null) {
  const last = readJson(join(dataDir, 'last.json'), null)
  console.log(
    [
      `Osmosis is ${s.isOn ? 'on' : 'off'} · level ${s.level} · density ${s.density} · model ${s.model} · cap ${s.cap}`,
      s.model === 'local' ? `Local server: ${s.endpoint}${s.localModel ? ` (${s.localModel})` : ''}` : `Codex binary: ${s.codex || 'auto'}`,
      usageLine(readJson(join(dataDir, 'usage.json'), { days: {} }), today()),
      last ? `Last run: ${last.status}${last.reason ? ` (${last.reason})` : ''} at ${last.at}, ${last.ms} ms` : 'Last run: none yet',
      `Settings file: ${path}`,
    ].join('\n'),
  )
} else {
  if (r.message !== HELP) writeJson(path, r.settings)
  console.log(r.message)
}
