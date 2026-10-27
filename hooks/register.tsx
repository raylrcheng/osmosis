import { atom, read, update } from 'claude-code'
import type { EngineInterface, ModelUsage, Register, Timer } from 'claude-code'

import type {

  OsmosisProgress,
  OsmosisProvider,
  OsmosisQuestion,
  OsmosisSettings,
  OsmosisUsage,
  OsmosisWord,
} from '../types'
import {
  DEFAULT_SETTINGS,
  EMPTY_PROGRESS,
  MIN_CHARS,
  RULES,
  buildPrompt,
  dayOf,
  rawFinalsFromHistory,
  hashText,
  isFinalBlock,
  keyFor,
  langInfo,
  normText,
  parseUtcOffset,
  phraseCap,
  setDayOffset,
  settingsHelp,
  SETTING_ROWS,
  parseReply,
  pickVoice,
  planCards,
  planMessage,
  reviewWords,
  LOCAL_NOTE,
  msToNextDay,
  scopeFor,
  swapCap,
  chunkBlock,
  mergeChunks,
  MAX_SWAPS,
  ankiNotes,
  exportWords,
  ttsClips,
} from './core'
import type { CardPlace, HistoryRow, OnScreenRows, Segment } from './core'
import { revertCopy } from './copyback'
import type { ShownBlock } from './copyback'
import { EMPTY_DICT, parseCedict, parseHsk, verifyWord } from './dict'
import type { Dict } from './dict'
import { drawBand, drawBank, drawHome, drawMessage, drawQuiz } from './draw'
import type { Els, ExampleView, PaneActions } from './draw'
import {
  EMPTY_USAGE,
  EXAMPLE_SCHEMA,
  addUsage,
  examplePrompt,
  isCapReached,
  isLocalUrl,
  localRequest,
  parseExample,
  parseLocalReply,
  wordsSchema,
} from './providers'
import type { CallUsage, ExampleReply } from './providers'

const PANE = 'osmosis'
const SETTLE_MS = 1200
const MIN_TRANSLATE = 200
const FLUSH_MS = 3000
const MAX_INFLIGHT = 2
const MAX_JOBS = 40
const CACHE_ITEMS = 500
const CACHE_CHARS = 2_500_000
const MAX_SEEN = 3000
const MAX_FINALS = 200
const EXAMPLE_ITEMS = 500
const LOCAL_TIMEOUT_MS = 90_000
// Haiku 4.5 runs without thinking unless asked; the `haiku` alias thinks by default.
// Haiku 5.5 always thinks; low effort keeps it short, a high cap keeps lists whole.
const HAIKU = 'claude-haiku-5-5'
const MAX_OUT = 8000
const EXAMPLE_SYSTEM = 'You write short example sentences for a language learner. Reply with strict JSON only.'

const settingsAtom = atom({ plugin: 'osmosis', key: 'settings' } as const, DEFAULT_SETTINGS)
const recentAtom = atom({ plugin: 'osmosis', key: 'recent' } as const, [])
const latestAtom = atom({ plugin: 'osmosis', key: 'latest' } as const, null)
const selectedAtom = atom({ plugin: 'osmosis', key: 'selected' } as const, null)
const viewAtom = atom({ plugin: 'osmosis', key: 'view' } as const, 'home')
const quizAtom = atom({ plugin: 'osmosis', key: 'quiz' } as const, null)
const progressAtom = atom({ plugin: 'osmosis', key: 'progress' } as const, EMPTY_PROGRESS)
const finalsAtom = atom({ plugin: 'osmosis', key: 'finals' } as const, [])
const usageAtom = atom({ plugin: 'osmosis', key: 'usage' } as const, EMPTY_USAGE)
const fallbacksAtom = atom({ plugin: 'osmosis', key: 'fallbacks' } as const, [])
const helpAtom = atom({ plugin: 'osmosis', key: 'help' } as const, null)
const healthAtom = atom({ plugin: 'osmosis', key: 'health' } as const, { local: 'unknown' as const })
const TX = { plugin: 'osmosis', key: 'tx' } as const
const EX = { plugin: 'osmosis', key: 'ex' } as const

type Job = { requestId: string; key: string; text: string; settings: OsmosisSettings; updatedAt: number; queuedAt: number; isFinal: boolean }
type ExJob = { id: string; target: string; romanization: string; gloss: string }

type $T = EngineInterface

const jobs = new Map<string, Job>()
const inflightKeys = new Set<string>()
const attempts = new Map<string, number>()
const cache = new Map<string, OsmosisWord[]>()
const exJobs = new Map<string, ExJob>()
const exInflight = new Set<string>()
const exCache = new Map<string, ExampleReply>()
let inflight = 0
let wakeTimer: Timer | null = null
let wakeAt = Infinity
let flushTimer: Timer | null = null
let clipTimer: Timer | null = null
const visible = new Set<string>()
let isUnreported = false
let cacheChars = 0
const entryChars = new Map<string, number>()
const planMemo = new Map<string, Plan>()
let isCacheDirty = false
let isProgressDirty = false
let isUsageDirty = false
let isExampleDirty = false
let voice: string | undefined
let isTicking = false
type Plan = { segs: Segment[]; cards: Map<number, CardPlace> | null; swaps: number }
let dict: Dict | null = null
let dictLoading: Promise<Dict> | null = null
const fallbackByMsg = new Map<string, string[]>()
const keyText = new Map<string, string>()
type ClipTool = { read: string[]; write: string[]; name: string }
const CLIP_TOOLS: ClipTool[] = [
  { name: 'pbpaste', read: ['pbpaste'], write: ['pbcopy'] },
  { name: 'wl-paste', read: ['wl-paste', '--no-newline'], write: ['wl-copy'] },
  { name: 'xclip', read: ['xclip', '-selection', 'clipboard', '-o'], write: ['xclip', '-selection', 'clipboard'] },
]
let clipTool: ClipTool | null | undefined
let lastClipHash: string | null = null
let isClipBusy = false
const trace: string[] = []
let isTraceDirty = false
let isTraceOn = false
// A session another Claude session started (an agent's worker) stays in English.
let isChild = false
let tracePath: string | null = null
const TRACE_LINES = 400
// Each session tags its lines; sessions share one debug.log.
const TRACE_TAG = Math.random().toString(36).slice(2, 6)
const CLIP_MS = 400
const CLIP_BLOCKS = 30
let isFallbackDirty = false

// ---------- persistence ----------

async function loadAll($: $T) {
  const stored = (await $.store.get('settings')) as Partial<OsmosisSettings> | undefined
  await update($, settingsAtom, () => ({ ...DEFAULT_SETTINGS, ...(stored ?? {}) }))
  const progress = (await $.store.get('progress')) as Partial<OsmosisProgress> | undefined
  if (progress) await update($, progressAtom, () => ({ ...EMPTY_PROGRESS, ...progress }))
  const usage = (await $.store.get('usage')) as OsmosisUsage | undefined
  if (usage && typeof usage.days === 'object') await update($, usageAtom, () => usage)
  const pairs = (await $.store.get('cache')) as [string, OsmosisWord[]][] | undefined
  if (Array.isArray(pairs)) for (const [k, words] of pairs) if (typeof k === 'string' && Array.isArray(words)) remember(k, words)
  const examples = (await $.store.get('examples')) as [string, ExampleReply][] | undefined
  if (Array.isArray(examples)) for (const [k, ex] of examples) if (typeof k === 'string' && ex?.target) exCache.set(k, ex)
  const v = await $.store.get('voice')
  if (typeof v === 'string') voice = v
}

async function loadFinals($: $T) {
  const rows = (await $.session.messages()) as unknown
  if (!Array.isArray(rows)) return
  const found = rawFinalsFromHistory(rows as HistoryRow[]).map(normText)
  if (found.length) await update($, finalsAtom, list => [...new Set([...found, ...list])].slice(-MAX_FINALS))
}

function rememberText(key: string, text: string) {
  if (keyText.get(key) === text) return
  keyText.delete(key)
  keyText.set(key, text)
  while (keyText.size > CACHE_ITEMS) keyText.delete(keyText.keys().next().value as string)
}

function shownBlocks(): ShownBlock[] {
  const out: ShownBlock[] = []
  for (const [key, text] of [...keyText.entries()].reverse()) {
    const words = cache.get(key)
    if (words && words.length) out.push({ text, words })
    if (out.length >= CLIP_BLOCKS) break
  }
  return out
}

async function findClipTool($: $T): Promise<ClipTool | null> {
  for (const tool of CLIP_TOOLS) {
    try {
      const r = await $.process.run(tool.read, { timeoutMs: 3000 })
      if (r.exitCode === 0) return tool
    } catch {
      // not installed here
    }
  }
  return null
}

async function watchClipboard($: $T) {
  if (isClipBusy) return
  isClipBusy = true
  try {
    const s = await read($, settingsAtom)
    if (clipTool === undefined) clipTool = await findClipTool($)
    if (!s.isOn || s.copy !== 'english' || !clipTool || (visible.size === 0 && !isUnreported)) return await syncClip($)
    const r = await $.process.run(clipTool.read, { timeoutMs: 3000 })
    if (r.exitCode !== 0 || r.isStdoutTruncated) return
    const hash = hashText(r.stdout)
    if (hash === lastClipHash) return
    const isFirst = lastClipHash === null
    lastClipHash = hash
    if (isFirst) return
    const english = revertCopy(r.stdout, shownBlocks(), s.show)
    if (english === null || english === r.stdout) return
    const w = await $.process.run(clipTool.write, { stdin: english, timeoutMs: 3000 })
    if (w.exitCode === 0) lastClipHash = hashText(english)
  } catch {
    // the clipboard stays as it was
  } finally {
    isClipBusy = false
  }
}

function note(line: string) {
  if (!isTraceOn) return
  trace.push(`${new Date().toISOString()} ${TRACE_TAG} ${line}`)
  if (trace.length > TRACE_LINES) trace.splice(0, trace.length - TRACE_LINES)
  isTraceDirty = true
}

async function dataDir($: $T): Promise<string> {
  const home = (await $.env.get('HOME')) ?? (await $.env.get('USERPROFILE')) ?? '.'
  const config = (await $.env.get('CLAUDE_CONFIG_DIR')) ?? `${home}/.claude`
  return `${config}/plugins/data/osmosis`
}

async function traceFile($: $T): Promise<string> {
  if (tracePath) return tracePath
  tracePath = `${await dataDir($)}/debug.log`
  return tracePath
}

async function flushTrace($: $T) {
  if (!isTraceDirty) return
  isTraceDirty = false
  const path = await traceFile($)
  const others = (await readText($, path).catch(() => '')).split('\n').filter(l => l && l.split(' ')[1] !== TRACE_TAG)
  const lines = [...others, ...trace].sort().slice(-TRACE_LINES * 4)
  await $.fs.write(path, `${lines.join('\n')}\n`)
}

async function readOffset($: $T) {
  try {
    const r = await $.process.run(['date', '+%z'], { timeoutMs: 3000 })
    const off = r.exitCode === 0 ? parseUtcOffset(r.stdout) : null
    if (off !== null) setDayOffset(off)
  } catch {
    // stay on UTC days
  }
}

async function flush($: $T) {
  flushTimer = null
  if (isCacheDirty) {
    isCacheDirty = false
    await $.store.set('cache', [...cache.entries()])
  }
  if (isProgressDirty) {
    isProgressDirty = false
    await $.store.set('progress', await read($, progressAtom))
  }
  if (isUsageDirty) {
    isUsageDirty = false
    await $.store.set('usage', await read($, usageAtom))
  }
  if (isExampleDirty) {
    isExampleDirty = false
    await $.store.set('examples', [...exCache.entries()])
  }
  await flushTrace($).catch(() => undefined)
}

function flushSoon($: $T) {
  if (!flushTimer) flushTimer = $.clock.after(FLUSH_MS, () => void flush($).catch(() => undefined))
}

// One pending wake-up for the worker; nothing runs while idle.
function wake($: $T, ms: number) {
  const at = Date.now() + ms
  if (wakeTimer && wakeAt <= at) return
  wakeTimer?.cancel()
  wakeAt = at
  wakeTimer = $.clock.after(Math.max(0, ms), () => {
    wakeTimer = null
    wakeAt = Infinity
    void tick($).catch(() => undefined)
  })
}

async function syncClip($: $T) {
  const s = await read($, settingsAtom)
  const want = s.isOn && s.copy === 'english' && clipTool !== null && (visible.size > 0 || (isUnreported && keyText.size > 0))
  if (want && !clipTimer) clipTimer = $.clock.every(CLIP_MS, () => void watchClipboard($))
  if (!want && clipTimer) {
    clipTimer.cancel()
    clipTimer = null
  }
}

async function detectVoice($: $T) {
  try {
    const { exitCode, stdout } = await $.process.run(['say', '-v', '?'], { timeoutMs: 10000 })
    if (exitCode !== 0) return
    const name = pickVoice(stdout)
    if (name) {
      voice = name
      await $.store.set('voice', name)
    }
  } catch {
    // no say on this machine: speak with the default voice
  }
}

function applyStatus($: $T, s: OsmosisSettings) {
  try {
    $.ui.status(s.isOn && s.isStatusOn ? `\u{1F331} ${langInfo(s.lang).label} · ${s.level}${s.model === 'local' ? ' · local' : ''}` : undefined)
  } catch {
    // status is cosmetic
  }
}

async function changeSettings($: $T, patch: Partial<OsmosisSettings>): Promise<OsmosisSettings> {
  const next = await update($, settingsAtom, s => ({ ...s, ...patch }))
  await $.store.set('settings', next)
  applyStatus($, next)
  await syncClip($)
  return next
}

async function changeProgress($: $T, fn: (p: OsmosisProgress) => OsmosisProgress) {
  await update($, progressAtom, fn)
  isProgressDirty = true
  flushSoon($)
}

// ---------- the dictionary ----------

async function readText($: $T, path: string): Promise<string> {
  const got = await $.fs.read(path)
  return typeof got === 'string' ? got : ''
}

async function loadDict($: $T): Promise<Dict> {
  const started = await $.clock.now()
  const root = `${$.plugin.root}/data`
  const sources = JSON.parse(await readText($, `${root}/sources.json`)) as { files: string[]; hsk: string }
  const rows = new Map<string, string>()
  for (const f of sources.files) parseCedict(await readText($, `${root}/${f}`), rows)
  const hsk = parseHsk(await readText($, `${root}/${sources.hsk}`))
  const ms = (await $.clock.now()) - started
  try {
    $.ui.log(`osmosis: CC-CEDICT loaded in ${ms} ms (${rows.size} words, ${hsk.size} HSK)`, { to: 'debug' })
  } catch {
    // logging is optional
  }
  return { rows, hsk }
}

async function ensureDict($: $T): Promise<Dict> {
  if (dict) return dict
  if (!dictLoading) {
    dictLoading = loadDict($)
      .catch(() => EMPTY_DICT)
      .then(d => {
        dict = d
        return d
      })
  }
  return dictLoading
}

// ---------- model calls ----------

type CallResult = ({ ok: true; text: string } | { ok: false; reason: string }) & { usage?: CallUsage }

function fromModelUsage(u: ModelUsage | undefined): CallUsage {
  return {
    input: u?.input_tokens ?? 0,
    output: u?.output_tokens ?? 0,
    cacheRead: u?.cache_read_input_tokens ?? 0,
    cacheWrite: u?.cache_creation_input_tokens ?? 0,
  }
}

async function recordUsage($: $T, provider: OsmosisProvider, u: CallUsage) {
  const day = dayOf(await $.clock.now())
  await update($, usageAtom, usage => addUsage(usage, day, provider, u))
  note(`usage ${provider} in=${u.input} out=${u.output} cacheRead=${u.cacheRead} cacheWrite=${u.cacheWrite}`)
  isUsageDirty = true
  flushSoon($)
}

async function setHealth($: $T, local: 'ok' | 'down') {
  const now = await read($, healthAtom)
  if (now.local !== local) await update($, healthAtom, () => ({ local }))
}

async function postLocal($: $T, url: string, body: string) {
  const timeout = $.clock.sleep(LOCAL_TIMEOUT_MS).then(() => null)
  const call = $.http
    .fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body })
    .catch(() => null)
  return Promise.race([call, timeout])
}

async function callLocal($: $T, s: OsmosisSettings, system: string, prompt: string, schema: object, maxTokens: number): Promise<CallResult> {
  if (!isLocalUrl(s.endpoint)) {
    await setHealth($, 'down')
    return { ok: false, reason: 'local-bad-endpoint' }
  }
  let req = localRequest(s, system, prompt, schema, maxTokens)
  let res = await postLocal($, req.url, req.body)
  if (res && res.status === 400) {
    req = localRequest(s, system, prompt, null, maxTokens)
    res = await postLocal($, req.url, req.body)
  }
  if (!res || !res.ok) {
    await setHealth($, 'down')
    return { ok: false, reason: 'local-unreachable' }
  }
  await setHealth($, 'ok')
  const reply = parseLocalReply(res.text)
  if (!reply) return { ok: false, reason: 'local-bad-reply' }
  note(`call model=local:${s.localModel || 'default'} maxTokens=${maxTokens} in=${reply.usage.input} out=${reply.usage.output}`)
  await recordUsage($, 'local', reply.usage)
  return { ok: true, text: reply.text, usage: reply.usage }
}

async function callHaiku($: $T, prompt: string, isWords: boolean, maxTokens: number): Promise<CallResult> {
  const r = await $.model.complete({
    model: HAIKU,
    prompt: isWords ? [{ text: RULES, cache: true }, { text: prompt }] : prompt,
    ...(isWords ? {} : { system: EXAMPLE_SYSTEM }),
    maxTokens: Math.max(maxTokens, MAX_OUT),
    effort: 'low',
    timeoutMs: 60000,
  })
  note(`call model=${HAIKU} effort=low maxTokens=${Math.max(maxTokens, MAX_OUT)} in=${r.usage.input_tokens} out=${r.usage.output_tokens}`)
  const usage = fromModelUsage(r.usage)
  await recordUsage($, 'haiku', usage)
  return r.isAnswered ? { ok: true, text: r.text, usage } : { ok: false, reason: r.reason, usage }
}

// ---------- the translation worker ----------

function remember(key: string, words: OsmosisWord[]) {
  forget(key)
  const size = JSON.stringify(words).length + key.length + 8
  cache.set(key, words)
  entryChars.set(key, size)
  cacheChars += size
  while (cache.size > CACHE_ITEMS || cacheChars > CACHE_CHARS) forget(cache.keys().next().value as string)
}

function forget(key: string) {
  cacheChars -= entryChars.get(key) ?? 0
  entryChars.delete(key)
  cache.delete(key)
}

async function settle($: $T, job: Job, words: OsmosisWord[], isFresh: boolean) {
  remember(job.key, words)
  rememberText(job.key, job.text)
  attempts.delete(job.key)
  if (isFresh) {
    isCacheDirty = true
    flushSoon($)
  }
  await $.state.set({ ...TX, id: job.key }, { status: 'ok', words })

  note(`settle key=${job.key} words=${words.length} fresh=${isFresh}`)
  try {
    await settleExtras($, job, words, isFresh)
  } catch {
    note(`settle key=${job.key} extras failed`)
  }
  try {
    $.ui.invalidate('ui.render')
  } catch {
    // the state write redraws the readers anyway
  }
}

async function settleExtras($: $T, job: Job, words: OsmosisWord[], isFresh: boolean) {
  if (words.length > 0) {
    await update($, recentAtom, list =>
      [...list.filter(r => r.key !== job.key), ...words.map((word, index) => ({ key: job.key, index, word }))].slice(-60),
    )
    await update($, latestAtom, () => job.key)
    if (isFresh) {
      const now = await $.clock.now()
      const today = dayOf(now)
      await changeProgress($, p => {
        const seen = { ...p.seen }
        for (const w of words) {
          const was = seen[w.target]
          seen[w.target] = { n: (was?.n ?? 0) + 1, en: w.en, gloss: w.gloss, romanization: w.romanization, last: now }
        }
        const keys = Object.keys(seen)
        if (keys.length > MAX_SEEN) {
          keys.sort((a, b) => seen[a]!.last - seen[b]!.last)
          for (const k of keys.slice(0, keys.length - MAX_SEEN)) delete seen[k]
        }
        const count = (p.today.date === today ? p.today.count : 0) + words.length
        return { ...p, seen, today: { date: today, count } }
      })
    }
  }
}

async function retryOrFail($: $T, job: Job, reason: string) {
  const n = (attempts.get(job.key) ?? 0) + 1
  attempts.set(job.key, n)
  if (attempts.size > 200) attempts.delete(attempts.keys().next().value as string)
  if (n < 2 && !jobs.has(job.requestId)) {
    jobs.set(job.requestId, { ...job, updatedAt: 0 })
    return wake($, 0)
  }
  note(`fail key=${job.key} reason=${reason} attempt=${n}`)
  await $.state.set({ ...TX, id: job.key }, { status: 'failed', reason })
}

async function translate($: $T, job: Job) {
  inflight++
  inflightKeys.add(job.key)
  try {
    const s = job.settings
    const chunks = chunkBlock(job.text, 4, 6)
    const caps = chunks.map(c => swapCap(job.text.slice(c.start, c.end), s.density))
    const total = Math.min(MAX_SWAPS, caps.reduce((a, b) => a + b, 0))
    if (total === 0) return await settle($, job, [], true)
    const progress = await read($, progressAtom)
    const isMandarin = langInfo(s.lang).isMandarin
    const opts = { isMandarin, known: new Set(Object.keys(progress.known)), maxPhrases: phraseCap(s.level, s.coverage), coverage: s.coverage }
    const d = isMandarin ? await ensureDict($) : EMPTY_DICT
    const lists: OsmosisWord[][] = chunks.map(() => [])
    let landed = 0
    let next = 0
    const run = async (i: number) => {
      const c = chunks[i]!
      const sub = job.text.slice(c.start, c.end)
      const prompt = buildPrompt(sub, s, reviewWords(progress), caps[i]!)
      const t0 = (await $.clock.now()) - job.queuedAt
      const r = s.model === 'local'
        ? await callLocal($, s, RULES + LOCAL_NOTE, prompt, wordsSchema(caps[i]!), 200 + caps[i]! * 80)
        : await callHaiku($, prompt, true, 60 + caps[i]! * 30)
      const parsed = r.ok ? parseReply(r.text, sub, { ...opts, cap: caps[i]! }) : null
      const t1 = (await $.clock.now()) - job.queuedAt
      note(`chunk key=${job.key} ${i + 1}/${chunks.length} sentences=${c.sentences} ms=${t0}->${t1} in=${r.usage?.input ?? 0} out=${r.usage?.output ?? 0}${r.ok ? '' : ` fail=${r.reason}`}`)
      if (!parsed?.ok) return
      const placed = parsed.words.map(w => ({ ...w, start: w.start + c.start, end: w.end + c.start }))
      const checked = isMandarin ? placed.map(w => verifyWord(w, d)) : placed
      lists[i] = d.rows.size ? checked.filter(w => w.verified) : checked
      landed++
      await $.state.set({ ...TX, id: job.key }, { status: 'ok', words: mergeChunks(job.text, lists, total, opts.maxPhrases, opts.known) })
    }
    const worker = async () => {
      while (next < chunks.length) await run(next++).catch(() => undefined)
    }
    await Promise.all(Array.from({ length: Math.min(12, chunks.length) }, worker))
    if (landed === 0) return await retryOrFail($, job, 'no-chunk-answered')
    await settle($, job, mergeChunks(job.text, lists, total, opts.maxPhrases, opts.known), true)
    note(`block key=${job.key} chunks=${chunks.length} landed=${landed} wall=${(await $.clock.now()) - job.queuedAt}ms`)
  } catch {
    await retryOrFail($, job, 'error').catch(() => undefined)
  } finally {
    inflight--
    inflightKeys.delete(job.key)
    wake($, 0)
  }
}

async function fetchExample($: $T, job: ExJob, s: OsmosisSettings) {
  exInflight.add(job.id)
  try {
    const prompt = examplePrompt(job.target, job.romanization, job.gloss, s)
    const r = s.model === 'local' ? await callLocal($, s, EXAMPLE_SYSTEM, prompt, EXAMPLE_SCHEMA, 400) : await callHaiku($, prompt, false, 400)
    const ex = r.ok ? parseExample(r.text) : null
    if (ex) {
      exCache.set(job.id, ex)
      if (exCache.size > EXAMPLE_ITEMS) exCache.delete(exCache.keys().next().value as string)
      isExampleDirty = true
      flushSoon($)
      await $.state.set({ ...EX, id: job.id }, { status: 'ok', target: ex.target, romanization: ex.romanization, en: ex.en })
    } else {
      await $.state.set({ ...EX, id: job.id }, { status: 'failed' })
    }
  } catch {
    await $.state.set({ ...EX, id: job.id }, { status: 'failed' }).catch(() => undefined)
  } finally {
    exInflight.delete(job.id)
    wake($, 0)
  }
}

async function tick($: $T) {
  if (isTicking) return
  isTicking = true
  await tickOnce($).finally(() => (isTicking = false))
}

async function tickOnce($: $T) {
  const now = await $.clock.now()
  const s = await read($, settingsAtom)
  const capped = isCapReached(await read($, usageAtom), dayOf(now), s)
  for (const job of [...exJobs.values()]) {
    if (exInflight.size > 0) break
    exJobs.delete(job.id)
    const hit = exCache.get(job.id)
    if (hit) await $.state.set({ ...EX, id: job.id }, { status: 'ok', target: hit.target, romanization: hit.romanization, en: hit.en })
    else if (!capped) void fetchExample($, job, s)
  }
  const ready = [...jobs.values()]
    .filter(j => !inflightKeys.has(j.key) && (cache.has(j.key) || j.isFinal || now - j.updatedAt >= SETTLE_MS))
    .sort((a, b) => b.updatedAt - a.updatedAt)
  for (const job of ready) {
    const hit = cache.get(job.key)
    if (hit) {
      jobs.delete(job.requestId)
      await settle($, job, hit, false)
      continue
    }
    if (inflight >= MAX_INFLIGHT) break
    if (capped && job.settings.model === 'haiku') continue
    jobs.delete(job.requestId)
    void translate($, job)
  }
  if (jobs.size > MAX_JOBS) {
    const old = [...jobs.values()].sort((a, b) => a.updatedAt - b.updatedAt).slice(0, jobs.size - MAX_JOBS)
    for (const j of old) jobs.delete(j.requestId)
  }
  if (isFallbackDirty) {
    isFallbackDirty = false
    const all = [...new Set([...fallbackByMsg.values()].flat())].slice(-200)
    await update($, fallbacksAtom, () => all)
  }
  const waiting = [...jobs.values()].filter(j => !inflightKeys.has(j.key))
  if (waiting.length === 0) return
  if (capped && waiting.every(j => j.settings.model === 'haiku')) return wake($, msToNextDay(now))
  wake($, Math.max(0, Math.min(...waiting.map(j => (j.isFinal ? 0 : j.updatedAt + SETTLE_MS - now)))))
}

function noteFallbacks(msgKey: string, scopes: string[]): boolean {
  const was = fallbackByMsg.get(msgKey) ?? []
  if (was.length === scopes.length && was.every((x, i) => x === scopes[i])) return false
  fallbackByMsg.delete(msgKey)
  if (scopes.length) fallbackByMsg.set(msgKey, scopes)
  while (fallbackByMsg.size > 60) fallbackByMsg.delete(fallbackByMsg.keys().next().value as string)
  return (isFallbackDirty = true)
}

// ---------- pane actions ----------

async function openPane($: $T) {
  const s = await read($, settingsAtom)
  await $.ui.open({ id: PANE, title: `Osmosis ${langInfo(s.lang).label}`, closeOnEscape: true })
}

async function wordsOf($: $T, key: string | null): Promise<OsmosisWord[]> {
  if (!key) return []
  const { value } = await $.state.get({ ...TX, id: key })
  return value?.status === 'ok' ? value.words : (cache.get(key) ?? [])
}

function exampleId(w: OsmosisWord): string {
  return hashText(`${w.target}|${w.gloss}`)
}

async function exampleFor($: $T, w: OsmosisWord, capped: boolean): Promise<ExampleView> {
  if (w.exampleTarget) return { status: 'ok', target: w.exampleTarget, romanization: w.exampleRomanization, en: w.exampleEn }
  const id = exampleId(w)
  const { value } = await $.state.get({ ...EX, id })
  if (value) return value
  const hit = exCache.get(id)
  if (hit) return { status: 'ok', ...hit }
  if (capped) return { status: 'cap' }
  if (!exInflight.has(id) && !exJobs.has(id)) {
    exJobs.set(id, { id, target: w.target, romanization: w.romanization, gloss: w.gloss })
    wake($, 0)
  }
  return { status: 'loading' }
}

async function speak($: $T, w: OsmosisWord, example: string) {
  const say = async (text: string) => {
    if (!text) return
    try {
      await $.audio.speak(text, voice ? { voice } : {})
    } catch {
      await $.audio.speak(text)
    }
  }
  try {
    await say(w.target)
    await say(example)
  } catch {
    $.ui.toast('Osmosis: speech is not available here (it needs macOS).')
  }
}

function buildQuiz(progress: OsmosisProgress, recent: readonly { word: OsmosisWord }[]): OsmosisQuestion[] {
  const pool = new Map<string, { target: string; romanization: string; gloss: string; isSaved: boolean }>()
  for (const w of Object.values(progress.saved)) pool.set(w.target, { target: w.target, romanization: w.romanization, gloss: w.gloss, isSaved: true })
  for (const { word: w } of [...recent].reverse()) if (!pool.has(w.target)) pool.set(w.target, { target: w.target, romanization: w.romanization, gloss: w.gloss, isSaved: false })
  for (const [t, s] of Object.entries(progress.seen).sort((a, b) => b[1].last - a[1].last).slice(0, 80)) {
    if (!pool.has(t)) pool.set(t, { target: t, romanization: s.romanization, gloss: s.gloss, isSaved: false })
  }
  const all = [...pool.values()].filter(x => x.gloss)
  if (all.length < 4) return []
  const shuffle = <T,>(xs: T[]): T[] => {
    const a = [...xs]
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1))
      ;[a[i], a[j]] = [a[j]!, a[i]!]
    }
    return a
  }
  const fresh = all.filter(x => !progress.known[x.target])
  const ordered = [...shuffle(fresh.filter(x => x.isSaved)), ...shuffle(fresh.filter(x => !x.isSaved)), ...shuffle(all.filter(x => progress.known[x.target]))]
  return ordered.slice(0, 5).map(q => {
    const others = shuffle(all.filter(x => x.target !== q.target && x.gloss !== q.gloss)).slice(0, 3)
    const choices = shuffle([q.target, ...others.map(o => o.target)])
    return { target: q.target, romanization: q.romanization, gloss: q.gloss, choices, answer: choices.indexOf(q.target) }
  })
}

async function startQuiz($: $T) {
  const progress = await read($, progressAtom)
  const recent = await read($, recentAtom)
  await update($, quizAtom, () => ({ questions: buildQuiz(progress, recent), index: 0, score: 0, feedback: '' }))
  await update($, viewAtom, () => 'quiz' as const)
}

function withExample(w: OsmosisWord): OsmosisWord {
  const ex = w.exampleTarget ? undefined : exCache.get(exampleId(w))
  return ex ? { ...w, exampleTarget: ex.target, exampleRomanization: ex.romanization, exampleEn: ex.en } : w
}

// Anki's own Python ships the anki library; these are its standard install paths.
async function ankiPython($: $T): Promise<string | null> {
  const home = await $.env.get('HOME')
  const local = await $.env.get('LOCALAPPDATA')
  const paths = [
    home && `${home}/Library/Application Support/AnkiProgramFiles/.venv/bin/python`,
    home && `${home}/.local/share/AnkiProgramFiles/.venv/bin/python`,
    local && `${local}\\AnkiProgramFiles\\.venv\\Scripts\\python.exe`,
  ]
  for (const path of paths) if (path && (await $.fs.exists(path))) return path
  return null
}

async function exportPath($: $T, today: string): Promise<string> {
  const home = (await $.env.get('HOME')) ?? (await $.env.get('USERPROFILE')) ?? '.'
  const dir = (await $.fs.exists(`${home}/Downloads`)) ? `${home}/Downloads` : home
  for (let n = 1; ; n++) {
    const path = `${dir}/osmosis-${today}${n > 1 ? `-${n}` : ''}.apkg`
    if (!(await $.fs.exists(path))) return path
  }
}

// Pinned: the first export installs this into every user's data folder.
const EDGE_TTS = 'edge-tts==7.3.1'

const lastLine = (text: string) => text.trim().split('\n').pop()?.slice(0, 120) || 'unknown error'

// edge-tts lives in a venv of its own in the plugin's data folder, made once from
// Anki's Python, so Anki's own install is never changed.
async function makeAudio($: $T, anki: string, words: readonly OsmosisWord[], media: string): Promise<string> {
  const venv = `${await dataDir($)}/tts`
  const python = anki.endsWith('.exe') ? `${venv}\\Scripts\\python.exe` : `${venv}/bin/python`
  let note = ''
  if (!(await $.fs.exists(`${venv}/ready`))) {
    for (const argv of [[anki, '-m', 'venv', venv], [python, '-m', 'pip', 'install', '-q', '--disable-pip-version-check', EDGE_TTS]]) {
      const r = await $.process.run(argv, { timeoutMs: 300_000 })
      if (r.exitCode !== 0) throw new Error(`edge-tts install failed: ${lastLine(r.stderr)}`)
    }
    await $.fs.write(`${venv}/ready`, '')
    note = ` First export: installed edge-tts in ${venv}.`
  }
  const clips = ttsClips(words)
  const timeoutMs = 60_000 + clips.length * 5_000
  const r = await $.process.run([python, `${$.plugin.root}/scripts/tts.py`, media], { stdin: JSON.stringify(clips), timeoutMs })
  const made = r.exitCode === 0 ? Number(lastLine(r.stdout)) : 0
  if (!made) throw new Error(lastLine(r.stderr))
  return made < clips.length ? ` Audio for ${made} of ${clips.length} clips: ${lastLine(r.stderr)}.${note}` : note
}

async function exportAnki($: $T, isAll: boolean): Promise<string> {
  const words = exportWords(await read($, progressAtom), isAll).map(withExample)
  if (words.length === 0) return 'Osmosis export: no new saved Mandarin words. /osmosis export all exports every saved word.'
  const python = await ankiPython($)
  if (!python) return 'Osmosis export: Anki not found. Install Anki 25.x from apps.ankiweb.net.'
  const today = dayOf(await $.clock.now())
  const out = await exportPath($, today)
  const media = `${await dataDir($)}/audio`
  const audio = await makeAudio($, python, words, media).catch((err: Error) => ` (no audio: ${err.message}; /osmosis export all adds it later)`)
  const script = `${$.plugin.root}/scripts/export-apkg.py`
  const r = await $.process.run([python, script, out, media], { stdin: JSON.stringify(ankiNotes(words)), timeoutMs: 60_000 })
  if (r.exitCode !== 0) return `Osmosis export failed: ${lastLine(r.stderr)}`
  await changeProgress($, p => ({ ...p, exported: { ...p.exported, ...Object.fromEntries(words.map(w => [w.target, today])) } }))
  const saved = `Osmosis export: ${words.length} word${words.length === 1 ? '' : 's'} saved to ${out}`
  return audio.startsWith(' (') ? `${saved}${audio}. Open it to import into Anki.` : `${saved}. Open it to import into Anki.${audio}`
}

function flip<T>(m: Record<string, T>, k: string, v: T | undefined): Record<string, T> {
  const { [k]: had, ...rest } = m
  return had !== undefined || v === undefined ? rest : { ...m, [k]: v }
}

function actions($: $T, key: string | null, words: readonly OsmosisWord[], example: string): PaneActions {
  return {
    speak: w => void speak($, w, example),
    toggleSave: w => void changeProgress($, p => ({ ...p, saved: flip(p.saved, w.target, w) })),
    toggleKnown: w => void changeProgress($, p => ({ ...p, known: flip(p.known, w.target, true as const) })),
    step: delta =>
      void update($, selectedAtom, sel => {
        if (!key || words.length === 0) return sel
        const at = sel && sel.key === key ? sel.index : -1
        return { key, index: (at + delta + words.length) % words.length }
      }),
    pick: i => void (key ? update($, selectedAtom, () => ({ key, index: i })) : undefined),
    close: () => void $.ui.close({ id: PANE }),
    home: () => void update($, viewAtom, () => 'home' as const),
    unsave: target => void changeProgress($, p => ({ ...p, saved: flip(p.saved, target, undefined) })),
    answer: choice =>
      void (async () => {
        const quiz = await read($, quizAtom)
        const q = quiz?.questions[quiz.index]
        if (!quiz || !q) return
        const isRight = choice === q.answer
        if (isRight) {
          await changeProgress($, p => {
            const n = (p.mastery[q.target] ?? 0) + 1
            const known = n >= 3 ? { ...p.known, [q.target]: true as const } : p.known
            return { ...p, mastery: { ...p.mastery, [q.target]: n }, known }
          })
        }
        const feedback = isRight
          ? `Right: ${q.target} ${q.romanization} = ${q.gloss}`
          : `Not quite: "${q.gloss}" is ${q.target} ${q.romanization}`
        await update($, quizAtom, cur =>
          cur ? { ...cur, index: cur.index + 1, score: cur.score + (isRight ? 1 : 0), feedback } : cur,
        )
      })(),
    retake: () => void startQuiz($),
    setSettings: patch => void changeSettings($, patch),
    openView: view => void (view === 'quiz' ? startQuiz($) : update($, viewAtom, () => 'bank' as const)),
    toggleHelp: row => void update($, helpAtom, open => (open === row ? null : row)),
    exportAnki: () => void exportAnki($, false).then(text => $.ui.toast(text)),
  }
}

type ReplyView = { columns: number; onScreen: OnScreenRows; isFirst: boolean }

function drawReply(
  $: $T,
  els: Els,
  view: ReplyView,
  text: string,
  words: OsmosisWord[],
  key: string,
  s: OsmosisSettings,
  status: string,
) {
  const memo = `${key}|${words.length}|${view.columns}|${s.show}|${s.card}|${view.onScreen?.first}|${view.onScreen?.last}`
  let plan = planMemo.get(memo)
  if (!plan) {
    const segs = planMessage(text, words)
    const cards = s.card === 'bar' ? null : planCards(segs, words, s.show, view.columns, view.onScreen)
    const swaps = segs.reduce((n, seg) => n + (seg.kind === 'prose' ? seg.lines.reduce((m, l) => m + l.tokens.filter(t => t.kind === 'swap').length, 0) : 0), 0)
    plan = { segs, cards, swaps }
    planMemo.set(memo, plan)
    if (planMemo.size > 64) planMemo.delete(planMemo.keys().next().value as string)
  }
  const { segs, cards, swaps } = plan
  if (swaps === 0) {
    note(`${status} swaps=0 (no prose block)`)
    return null
  }
  if (cards && noteFallbacks(key, [...cards.entries()].filter(([, p]) => p.kind === 'bar').map(([i]) => scopeFor(key, i)))) wake($, 0)
  const pick = (index: number) =>
    void (async () => {
      note(`click key=${key} index=${index}`)
      flushSoon($)
      await update($, selectedAtom, () => ({ key, index }))
      await update($, viewAtom, () => 'home' as const)
      await openPane($)
    })()
  const floating = cards ? [...cards.values()].filter(p => p.kind !== 'bar').length : 0
  note(`${status} swaps=${swaps} cards=${floating} bar=${cards ? cards.size - floating : 0}`)
  const say = (index: number) => {
    note(`say key=${key} index=${index}`)
    const w = words[index]
    if (w) void speak($, w, '')
  }
  return drawMessage(els, segs, words, key, view.isFirst, s, pick, cards, say)
}


export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    try {
      isChild = Boolean(await $.env.get('CLAUDE_CODE_CHILD_SESSION'))
    } catch {
      isChild = false
    }
    if (isChild) return next(e)
    try {
      await loadAll($)
    } catch {
      // first run, or a store that cannot be read: defaults stand
    }
    try {
      await loadFinals($)
    } catch {
      // no history to read
    }
    try {
      await $.command.register({
        name: 'osmosis',
        description: 'Osmosis Chinese practice: open the word pane, or change settings',
        argumentHint: '[help|on|off|level|density|show|coverage|card|band|status|copy|cap|model|endpoint|bank|quiz|export|lang]',
        immediate: true,
      })
    } catch {
      // commands unavailable here
    }
    await readOffset($)
    const started = await read($, settingsAtom)
    isTraceOn = started.debug
    applyStatus($, started)
    void detectVoice($)
    return next(e)
  })

  on('ui.copy', async ($, e, next) => {
    if (isChild) return next(e)
    try {
      const s = await read($, settingsAtom)
      if (s.isOn && s.copy === 'english') {
        const english = revertCopy(e.text, shownBlocks(), s.show)
        if (english !== null) return next({ ...e, text: english })
      }
    } catch {
      // copy as given
    }
    return next(e)
  }).catch(($, e, next) => next(e))

  on('session.end', async ($, e, next) => {
    try {
      await flush($)
    } catch {
      // nothing to save
    }
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    const answer = normText(e.answer)
    if (!isChild && e.agentId === undefined && answer.length >= MIN_CHARS) {
      try {
        await update($, finalsAtom, list => [...list.filter(f => f !== answer), answer].slice(-MAX_FINALS))
      } catch {
        // the reply stays in English
      }
    }
    return next(e)
  })

  on('ui.render', { component: 'AssistantMessage' }, async ($, e, next) => {
    const text = e.props.text
    if (isChild || e.props.isSummary || text.length < MIN_CHARS) return next(e)
    const s = await read($, settingsAtom)
    if (!s.isOn) return next(e)
    const key = keyFor(text, s)
    const { value: tx } = await $.state.get({ ...TX, id: key })
    const hit = tx?.status === 'ok' ? undefined : cache.get(key)
    const open = tx === undefined && !hit && text.length >= MIN_TRANSLATE
    const isFinal = open && isFinalBlock(text, await read($, finalsAtom))
    let queued = false
    if ((isFinal || (hit && tx === undefined)) && e.props.onScreen !== null && !inflightKeys.has(key) && jobs.get(e.requestId)?.key !== key) {
      const now = await $.clock.now()
      jobs.set(e.requestId, { requestId: e.requestId, key, text, settings: s, updatedAt: now, queuedAt: now, isFinal })
      wake($, hit || isFinal ? 0 : SETTLE_MS)
      queued = true
    }
    if (isTraceDirty) flushSoon($)
    const words = tx?.status === 'ok' ? tx.words : hit
    const status = `render surface=${e.surface} key=${key} tx=${tx?.status ?? 'none'} hit=${hit ? 'yes' : 'no'} final=${isFinal ? 'yes' : 'no'} queued=${queued ? 'yes' : 'no'}`
    if (!words || words.length === 0) {
      note(status)
      return next(e)
    }
    rememberText(key, text)
    const was = visible.size + Number(isUnreported)
    if (e.props.onScreen === undefined) isUnreported = true
    else if (e.props.onScreen === null) visible.delete(key)
    else visible.add(key)
    if (visible.size + Number(isUnreported) !== was) await syncClip($)
    try {
      const { Box, Text, Button, Markdown, Link } = $.ui.resolve(e)
      const view = { columns: e.viewport?.columns ?? 100, onScreen: e.props.onScreen, isFirst: e.props.isFirstOfReply }
      return drawReply($, { Box, Text, Button, Markdown, Link }, view, text, words, key, s, status) ?? next(e)
    } catch (err) {
      note(`${status} error=${err instanceof Error ? err.name : 'unknown'}`)
      return next(e)
    }
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (isChild) return next(e)
    const s = await read($, settingsAtom)
    if (!s.isOn || !s.isBandOn || e.props.hasSurvey) return next(e)
    const recent = await read($, recentAtom)
    const progress = await read($, progressAtom)
    const today = dayOf(await $.clock.now())
    const count = progress.today.date === today ? progress.today.count : 0
    const usage = await read($, usageAtom)
    const health = await read($, healthAtom)
    const notice = isCapReached(usage, today, s)
      ? 'daily cap reached'
      : s.model === 'local' && health.local === 'down'
        ? 'local model unreachable'
        : ''
    const { Box, Text, Button, Markdown, Link } = $.ui.resolve(e)
    return drawBand({ Box, Text, Button, Markdown, Link }, recent, s, count, e.props.bodyColumns, notice, await read($, fallbacksAtom))
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const els = (({ Box, Text, Button, Markdown, Link }) => ({ Box, Text, Button, Markdown, Link }))($.ui.resolve(e))
    const s = await read($, settingsAtom)
    const view = await read($, viewAtom)
    note(`pane surface=${e.surface} placement=${e.props.placement} focused=${e.props.isFocused}`)
    const progress = await read($, progressAtom)
    if (view === 'bank') return drawBank(els, progress, actions($, null, [], ''))
    if (view === 'quiz') return drawQuiz(els, await read($, quizAtom), actions($, null, [], ''))
    const selected = await read($, selectedAtom)
    const latest = await read($, latestAtom)
    const key = selected?.key ?? latest
    const words = await wordsOf($, key)
    const index = selected && selected.key === key && selected.index < words.length ? selected.index : null
    const usage = await read($, usageAtom)
    const today = dayOf(await $.clock.now())
    const w = index === null ? undefined : words[index]
    const example: ExampleView | null = w ? await exampleFor($, w, isCapReached(usage, today, s)) : null
    const exampleText = example?.status === 'ok' ? example.target : ''
    const copyNote = clipTool === null ? 'Unavailable: no pbpaste, wl-paste or xclip found.' : ''
    return drawHome(els, s, words, index, progress, actions($, key, words, exampleText), example, usage, today, copyNote, await read($, helpAtom))
  })

  on('command.run', { command: 'osmosis' }, async ($, e) => {
    const [verb = '', ...rest] = e.args.trim().split(/\s+/).filter(Boolean)
    const arg = (rest[0] ?? '').toLowerCase()
    const v = verb.toLowerCase()
    try {
      if (v === '') {
        await update($, viewAtom, () => 'home' as const)
        await update($, selectedAtom, () => null)
        await openPane($)
        const s = await read($, settingsAtom)
        return { text: `Osmosis pane opened (${s.isOn ? 'on' : 'off'}, ${s.level}, ${s.density} density).` }
      }
      if (v === 'help') return { text: settingsHelp() }
      if (v === 'close') {
        await $.ui.close({ id: PANE })
        return { text: 'Osmosis pane closed.' }
      }
      const isToggle = v === 'on' || v === 'off'
      const row = SETTING_ROWS.find(r => (isToggle ? r.command === 'on|off' : r.command === v))
      const choice = row?.values.find(x => x[0] === (isToggle ? v : arg))
      if (row && choice) {
        const s = await changeSettings($, { [row.key]: choice[2] } as Partial<OsmosisSettings>)
        const extra = row.key === 'model' && s.model === 'local' ? ` Endpoint: ${s.endpoint}.` : ''
        const name = row.key === 'isOn' ? 'Osmosis' : `Osmosis ${row.label.toLowerCase()}`
        return { text: `${name}: ${choice[1]}. ${row.help}${extra}` }
      }
      if (v === 'endpoint' && rest[0] && isLocalUrl(rest[0])) {
        await changeSettings($, { endpoint: rest[0].slice(0, 200) })
        return { text: `Osmosis local endpoint: ${rest[0].slice(0, 200)}.` }
      }
      if (v === 'local-model' && rest[0]) {
        await changeSettings($, { localModel: rest.join(' ').slice(0, 120) })
        return { text: `Osmosis local model name: ${rest.join(' ').slice(0, 120)}.` }
      }
      if (v === 'lang' && rest.length > 0) {
        const lang = rest.join(' ').slice(0, 40)
        await changeSettings($, { lang })
        return { text: `Osmosis language: ${langInfo(lang).name}.` }
      }
      if (v === 'debug' && (arg === 'on' || arg === 'off')) {
        await changeSettings($, { debug: arg === 'on' })
        if (arg === 'off') await flushTrace($).catch(() => undefined)
        isTraceOn = arg === 'on'
        note('debug trace on')
        return { text: arg === 'on' ? `Osmosis debug trace on: ${await traceFile($)} (keys and counts only, no reply text).` : 'Osmosis debug trace off.' }
      }
      if (v === 'bank') {
        await update($, viewAtom, () => 'bank' as const)
        await openPane($)
        const n = Object.keys((await read($, progressAtom)).saved).length
        return { text: `Osmosis word bank: ${n} saved.` }
      }
      if (v === 'export') return { text: await exportAnki($, arg === 'all') }
      if (v === 'quiz') {
        await startQuiz($)
        await openPane($)
        return { text: 'Osmosis quiz opened.' }
      }
      return { text: settingsHelp() }
    } catch {
      return { text: 'Osmosis: that did not work. Try /osmosis help.' }
    }
  })
}

