// Osmosis for Codex: picks a few words from a finished reply and formats a vocab card.
// Reuses the Claude version's prompt, parsing and CC-CEDICT check from hooks/*.ts (Node strips the types).
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { registerHooks } from 'node:module'
import { homedir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import * as core from '../hooks/core.ts'
import { EMPTY_DICT, parseCedict, parseHsk, verifyWord } from '../hooks/dict.ts'

// hooks/providers.ts imports './core' without an extension, as the Claude mod bundler allows.
const HOOKS_DIR = new URL('../hooks/', import.meta.url).href
registerHooks({
  resolve(specifier, context, next) {
    if (context.parentURL?.startsWith(HOOKS_DIR) && /^\.\.?\/[^.]+$/.test(specifier)) return next(`${specifier}.ts`, context)
    return next(specifier, context)
  },
})
const providers = await import('../hooks/providers.ts')

export const CHILD_ENV = 'OSMOSIS_CHILD'
export const CHILD_DIR = 'osmosis-child'
export const DEADLINE_MS = 30_000
export const MAX_PROMPT_CHARS = 4000
export const CARD_WORDS = { low: 2, normal: 4, high: 6 }
const LEVELS = ['beginner', 'intermediate', 'advanced']
const DENSITIES = ['low', 'normal', 'high']
const CAPS = ['off', '100k', '300k', '1m']
const APP_CODEX = '/Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex'

export const DEFAULTS = Object.freeze({
  isOn: true,
  level: 'beginner',
  density: 'normal',
  model: 'gpt-6-luna',
  endpoint: 'http://127.0.0.1:8080/v1',
  localModel: '',
  cap: '1m',
  codex: '',
})

// ---------- settings ----------

const oneOf = (v, list, fallback) => (list.includes(v) ? v : fallback)
const text = (v, fallback, max = 300) => (typeof v === 'string' ? v.trim().slice(0, max) : fallback)

export function parseSettings(raw) {
  let o = raw
  if (typeof raw === 'string') {
    try {
      o = JSON.parse(raw)
    } catch {
      o = {}
    }
  }
  if (!o || typeof o !== 'object' || Array.isArray(o)) o = {}
  const model = text(o.model, DEFAULTS.model, 80)
  return {
    isOn: typeof o.isOn === 'boolean' ? o.isOn : DEFAULTS.isOn,
    level: oneOf(o.level, LEVELS, DEFAULTS.level),
    density: oneOf(o.density, DENSITIES, DEFAULTS.density),
    model: /^[\w.:-]+$/.test(model) ? model : DEFAULTS.model,
    endpoint: text(o.endpoint, DEFAULTS.endpoint) || DEFAULTS.endpoint,
    localModel: text(o.localModel, DEFAULTS.localModel, 120),
    cap: oneOf(o.cap, CAPS, DEFAULTS.cap),
    codex: text(o.codex, DEFAULTS.codex, 1000),
  }
}

export const HELP = [
  'Osmosis settings (node codex/settings.mjs <setting> <value>):',
  '- on|off: show the vocab card under each reply, or not.',
  '- level beginner|intermediate|advanced: HSK 1-2, 3-4, or 5-6 words.',
  '- density low|normal|high: up to 2, 4, or 6 words per card.',
  '- model gpt-6-luna|<Codex model>|local: who picks the words. Codex models run on your Codex login.',
  '- endpoint <url>: local OpenAI-compatible server (default http://127.0.0.1:8080/v1).',
  '- local-model <name>: model name sent to the local server (Ollama, LM Studio).',
  '- cap off|100k|300k|1m: stop after this many Codex model tokens a day (default 1m).',
  '- codex <path>|auto: the codex binary for word picking (auto picks the newest installed).',
  '- status: current settings, today\'s usage and the last run.',
].join('\n')

// Returns the new settings and a one-line message, or an error line.
export function applyCommand(s, args) {
  const [cmd = 'status', ...rest] = args.map(a => String(a).trim()).filter(Boolean)
  const value = rest.join(' ')
  const set = (patch, message) => ({ settings: { ...s, ...patch }, message })
  const bad = what => ({ error: `Osmosis: ${what}. Type "help" for the list.` })
  switch (cmd.toLowerCase()) {
    case 'on':
    case 'off':
      return set({ isOn: cmd.toLowerCase() === 'on' }, `Osmosis: ${cmd.toLowerCase()}.`)
    case 'level':
      return LEVELS.includes(value) ? set({ level: value }, `Osmosis level: ${value}.`) : bad('level is beginner, intermediate or advanced')
    case 'density':
      return DENSITIES.includes(value) ? set({ density: value }, `Osmosis density: ${value}.`) : bad('density is low, normal or high')
    case 'cap':
      return CAPS.includes(value.toLowerCase()) ? set({ cap: value.toLowerCase() }, `Osmosis daily cap: ${value.toLowerCase()}.`) : bad('cap is off, 100k, 300k or 1m')
    case 'model':
      return /^[\w.:-]+$/.test(value) ? set({ model: value }, `Osmosis model: ${value}.`) : bad('model is a Codex model name or local')
    case 'endpoint':
      return /^https?:\/\//i.test(value) ? set({ endpoint: value }, `Osmosis endpoint: ${value}.`) : bad('endpoint is an http(s) URL')
    case 'local-model':
      return set({ localModel: value }, `Osmosis local model: ${value || '(server default)'}.`)
    case 'codex':
      return set({ codex: value === 'auto' ? '' : value }, `Osmosis codex binary: ${value && value !== 'auto' ? value : 'auto'}.`)
    case 'help':
      return { settings: s, message: HELP }
    case 'status':
      return { settings: s, message: null }
    default:
      return bad(`unknown setting "${cmd}"`)
  }
}

// PLUGIN_DATA is set for hooks only; a skill or a shell finds the same folder from the install path.
export function dataDirFor(env, scriptPath, home = homedir()) {
  if (env.PLUGIN_DATA) return env.PLUGIN_DATA
  const m = /^(.*)[\\/]plugins[\\/]cache[\\/]([^\\/]+)[\\/]([^\\/]+)[\\/]/.exec(scriptPath)
  if (m) return join(m[1], 'plugins', 'data', `${m[3]}-${m[2]}`)
  return join(env.CODEX_HOME || join(home, '.codex'), 'osmosis')
}

export function readJson(path, fallback) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    return fallback
  }
}

export function writeJson(path, value) {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`)
}

// ---------- the recursion guard ----------

// The word-picking `codex exec` is itself a Codex session; its hooks must never pick words again.
export function isChildRun(input, env) {
  if (env[CHILD_ENV] === '1') return true
  return typeof input?.cwd === 'string' && basename(input.cwd) === CHILD_DIR
}

// ---------- what to send ----------

// Skips short or code-heavy replies; otherwise the leading prose, cut at a chunk boundary.
export function cardSource(reply, s) {
  if (typeof reply !== 'string' || reply.trim().length < core.MIN_CHARS) return null
  const prose = core.eligibleRanges(reply).reduce((n, r) => n + r.end - r.start, 0)
  if (prose < core.MIN_CHARS || prose / reply.length < 0.3) return null
  const chunks = core.chunkBlock(reply, 4, 6)
  if (!chunks.length) return null
  const from = chunks[0].start
  let end = chunks[0].end
  for (const c of chunks.slice(1)) {
    if (c.end - from > MAX_PROMPT_CHARS) break
    end = c.end
  }
  const sub = reply.slice(from, end)
  const cap = Math.min(CARD_WORDS[s.density], core.swapCap(sub, s.density))
  return cap > 0 ? { text: sub, cap } : null
}

const coreSettings = s => ({ ...core.DEFAULT_SETTINGS, level: s.level, density: s.density, lang: 'Mandarin' })

export function buildPrompt(src, s) {
  return core.buildPrompt(src.text, coreSettings(s), [], src.cap)
}

// Keeps only words CC-CEDICT knows; the dictionary sets pinyin and HSK.
export function pickWords(modelReply, src, s, dict) {
  const parsed = core.parseReply(modelReply, src.text, {
    isMandarin: true,
    known: new Set(),
    cap: src.cap,
    maxPhrases: core.phraseCap(s.level, 'natural'),
    coverage: 'natural',
  })
  if (!parsed.ok) return null
  const checked = parsed.words.map(w => verifyWord(w, dict))
  return dict.rows.size ? checked.filter(w => w.verified) : checked
}

// ---------- the card ----------

// Codex shows a hook's systemMessage as "↳ Hook · <first line>", then the other lines indented.
export function formatCard(words, s) {
  const seen = new Set()
  const lines = []
  for (const w of words) {
    if (seen.has(w.target)) continue
    seen.add(w.target)
    const breakdown = [...w.target].length > 1 && w.literal.includes(' + ') ? w.literal : ''
    lines.push([`${w.target} ${w.romanization}`.trim(), w.gloss || w.dictGloss, w.level ? `HSK ${w.level}` : '', breakdown].filter(Boolean).join(' · '))
  }
  return lines.length ? [`\u{1F331} 中文 · ${s.level}`, ...lines].join('\n') : null
}

// ---------- the Codex model call ----------

export function execArgs({ model, childDir, rulesPath }) {
  const off = ['hooks', 'plugins', 'apps', 'shell_tool', 'unified_exec', 'view_image', 'image_generation', 'multi_agent', 'goals', 'browser_use', 'computer_use', 'tool_suggest', 'skill_search', 'in_app_browser', 'personality']
  return [
    'exec',
    '--ephemeral',
    '--ignore-user-config',
    '--skip-git-repo-check',
    ...off.flatMap(f => ['--disable', f]),
    '--sandbox', 'read-only',
    '-C', childDir,
    '-m', model,
    '-c', 'model_reasoning_effort="low"',
    '-c', `model_instructions_file=${JSON.stringify(rulesPath)}`,
    '-c', 'web_search="disabled"',
    '-c', 'skills.include_instructions=false',
    '-c', 'skills.bundled.enabled=false',
    '-c', 'include_permissions_instructions=false',
    '-c', 'include_apps_instructions=false',
    '-c', 'include_environment_context=false',
    '-c', 'include_collaboration_mode_instructions=false',
    '-c', 'project_doc_max_bytes=0',
    '--json',
    '-',
  ]
}

// Reads `codex exec --json` events: the last agent message and the turn's token usage.
export function parseExecJsonl(stdout) {
  let reply = null
  let usage = null
  let reason = null
  for (const line of stdout.split('\n')) {
    if (!line.trim().startsWith('{')) continue
    let e
    try {
      e = JSON.parse(line)
    } catch {
      continue
    }
    if (e.type === 'item.completed' && e.item?.type === 'agent_message' && typeof e.item.text === 'string') reply = e.item.text
    else if (e.type === 'turn.completed' && e.usage) usage = { input: Number(e.usage.input_tokens) || 0, output: Number(e.usage.output_tokens) || 0, cacheRead: 0, cacheWrite: 0 }
    else if (e.type === 'turn.failed' || e.type === 'error') reason = String(e.error?.message ?? e.message ?? 'error').slice(0, 300)
  }
  if (reply !== null) return { ok: true, text: reply, usage }
  return { ok: false, reason: reason ?? 'no-reply', usage }
}

export function parseVersion(s) {
  const m = /(\d+)\.(\d+)\.(\d+)/.exec(s ?? '')
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null
}

export function newest(found) {
  const cmp = (a, b) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2]
  return found.filter(f => f.version).sort((a, b) => cmp(b.version, a.version))[0]?.bin ?? null
}

// New models need a new Codex; the desktop app often bundles a newer CLI than the one on PATH.
export function resolveCodexBin(s) {
  if (s.codex) return s.codex
  const found = ['codex', APP_CODEX].map(bin => {
    const r = spawnSync(bin, ['--version'], { encoding: 'utf8', timeout: 3000 })
    return { bin, version: r.status === 0 ? parseVersion(r.stdout) : null }
  })
  return newest(found) ?? 'codex'
}

function run(bin, args, input, opts) {
  return new Promise(resolve => {
    let stdout = ''
    let done = false
    const finish = r => {
      if (!done) resolve(r)
      done = true
    }
    const child = spawn(bin, args, { ...opts, stdio: ['pipe', 'pipe', 'ignore'], timeout: opts.timeout, killSignal: 'SIGKILL' })
    child.stdout.on('data', d => (stdout += d))
    child.on('error', () => finish({ code: -1, stdout }))
    child.on('close', code => finish({ code, stdout }))
    child.stdin.on('error', () => undefined)
    child.stdin.end(input)
  })
}

export async function callCodex(prompt, s, ctx) {
  const childDir = join(ctx.dataDir, CHILD_DIR)
  const rulesPath = join(ctx.dataDir, 'rules.txt')
  mkdirSync(childDir, { recursive: true })
  if (!existsSync(rulesPath) || readFileSync(rulesPath, 'utf8') !== core.RULES) writeFileSync(rulesPath, core.RULES)
  const bin = resolveCodexBin(s)
  const r = await run(bin, execArgs({ model: s.model, childDir, rulesPath }), prompt, {
    cwd: childDir,
    env: { ...ctx.env, [CHILD_ENV]: '1' },
    timeout: Math.max(1000, ctx.deadline - Date.now()),
  })
  const parsed = parseExecJsonl(r.stdout)
  return parsed.ok || r.code === 0 ? parsed : { ...parsed, reason: parsed.reason === 'no-reply' ? `codex-exit-${r.code}` : parsed.reason }
}

// ---------- the local model call ----------

export async function callLocal(prompt, s, ctx, fetchImpl = fetch) {
  if (!providers.isLocalUrl(s.endpoint)) return { ok: false, reason: 'local-bad-endpoint' }
  const post = async schema => {
    const req = providers.localRequest(s, core.RULES + core.LOCAL_NOTE, prompt, schema, 200 + 6 * 80)
    return fetchImpl(req.url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: req.body, signal: AbortSignal.timeout(Math.max(1000, ctx.deadline - Date.now())) })
  }
  try {
    let res = await post(providers.wordsSchema(CARD_WORDS.high))
    if (res.status === 400) res = await post(null)
    if (!res.ok) return { ok: false, reason: `local-http-${res.status}` }
    const reply = providers.parseLocalReply(await res.text())
    return reply ? { ok: true, text: reply.text, usage: reply.usage } : { ok: false, reason: 'local-bad-reply' }
  } catch {
    return { ok: false, reason: 'local-unreachable' }
  }
}

// ---------- the dictionary ----------

export function loadDict(dataUrl = new URL('../data/', import.meta.url)) {
  try {
    const root = fileURLToPath(dataUrl)
    const sources = JSON.parse(readFileSync(join(root, 'sources.json'), 'utf8'))
    const rows = new Map()
    for (const f of sources.files) parseCedict(readFileSync(join(root, f), 'utf8'), rows)
    return { rows, hsk: parseHsk(readFileSync(join(root, sources.hsk), 'utf8')) }
  } catch {
    return EMPTY_DICT
  }
}

// ---------- usage and the daily cap ----------

export function today(now = Date.now()) {
  core.setDayOffset(-new Date(now).getTimezoneOffset())
  return core.dayOf(now)
}

export function isCapped(usage, day, s) {
  const limit = providers.capTokens(s.cap)
  return s.model !== 'local' && limit !== null && providers.totalTokens(usage.days?.[day]?.codex) >= limit
}

export function usageLine(usage, day) {
  const t = usage.days?.[day]
  const part = (name, x) => (x ? `${name}: ${x.calls} call${x.calls === 1 ? '' : 's'} · ${providers.fmtTokens(providers.totalTokens(x))} tokens` : '')
  return [part('Codex model today', t?.codex), part('Local model today', t?.local)].filter(Boolean).join('\n') || 'No model calls today.'
}

// ---------- the Stop hook ----------

// Returns the card text, or null for no card. Writes usage and a short last-run note (never reply text).
export async function runStop(input, ctx) {
  const settingsPath = join(ctx.dataDir, 'settings.json')
  const usagePath = join(ctx.dataDir, 'usage.json')
  const started = Date.now()
  const note = (status, extra = {}) => {
    try {
      writeJson(join(ctx.dataDir, 'last.json'), { at: new Date().toISOString(), status, ms: Date.now() - started, ...extra })
    } catch {
      // the note is optional
    }
  }
  if (isChildRun(input, ctx.env)) return null
  const s = parseSettings(readJson(settingsPath, {}))
  if (!s.isOn) return null
  const src = cardSource(input?.last_assistant_message, s)
  if (!src) return null
  const day = today()
  const usage = readJson(usagePath, providers.EMPTY_USAGE)
  if (isCapped(usage, day, s)) {
    note('capped')
    return null
  }
  const prompt = buildPrompt(src, s)
  const call = ctx.callModel ?? (s.model === 'local' ? callLocal : callCodex)
  const r = await call(prompt, s, ctx)
  if (r.usage) {
    try {
      writeJson(usagePath, providers.addUsage(usage, day, s.model === 'local' ? 'local' : 'codex', r.usage))
    } catch {
      // usage is best effort
    }
  }
  if (!r.ok) {
    note('failed', { reason: r.reason, model: s.model })
    return null
  }
  const words = pickWords(r.text, src, s, ctx.dict ?? loadDict()) ?? []
  const card = formatCard(words, s)
  note(card ? 'card' : 'no-words', { words: words.length, model: s.model, tokens: r.usage ? r.usage.input + r.usage.output : 0 })
  return card
}
