import type {
  OsmosisDensity,
  OsmosisLevel,
  OsmosisProgress,
  OsmosisSettings,
  OsmosisWord,
} from '../types'

export const MIN_CHARS = 40
export const MAX_SWAPS = 30

export const DEFAULT_SETTINGS: OsmosisSettings = {
  isOn: true,
  level: 'beginner',
  density: 'normal',
  show: 'hanzi',
  isBandOn: true,
  isStatusOn: true,
  isFocusOn: true,
  copy: 'english',
  debug: false,
  coverage: 'natural',
  card: 'word',
  cap: '300k',
  model: 'haiku',
  endpoint: 'http://127.0.0.1:8080/v1',
  localModel: '',
  lang: 'Mandarin',
}

export const EMPTY_PROGRESS: OsmosisProgress = {
  seen: {},
  known: {},
  saved: {},
  mastery: {},
  today: { date: '', count: 0 },
  exported: {},
}

export function hashText(text: string): string {
  let a = 0x811c9dc5
  let b = 0x01000193 ^ text.length
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i)
    a = Math.imul(a ^ c, 0x01000193)
    b = Math.imul(b ^ c, 0x5bd1e995)
    b ^= b >>> 15
  }
  return (a >>> 0).toString(16).padStart(8, '0') + (b >>> 0).toString(16).padStart(8, '0')
}

export function keyFor(text: string, s: OsmosisSettings): string {
  return hashText(`${s.lang}|${s.level}|${s.density}|${s.coverage}|${text}`)
}

export function scopeFor(key: string, index: number): string {
  return `tw-${key}-${index}`
}

export type LangInfo = { isMandarin: boolean; label: string; name: string }

export function langInfo(lang: string): LangInfo {
  const isMandarin = /mandarin|chinese|中文|普通话|^zh/i.test(lang.trim())
  return isMandarin
    ? { isMandarin, label: '中文', name: 'Mandarin Chinese' }
    : { isMandarin, label: lang.trim(), name: lang.trim() }
}

// ---------- block splitting ----------

export type Block = { start: number; end: number; isProse: boolean }
type Line = { start: number; end: number; text: string }

const FENCE = /^\s*(`{3,}|~{3,})/

function linesOf(text: string): Line[] {
  const out: Line[] = []
  let pos = 0
  for (const raw of text.split('\n')) {
    out.push({ start: pos, end: pos + raw.length, text: raw })
    pos += raw.length + 1
  }
  return out
}

function isProseLine(t: string): boolean {
  if (/^( {4,}|\t)/.test(t)) return false
  const s = t.trimStart()
  if (/^(#|>|\||<)/.test(s)) return false
  if (/^(-{3,}|={3,}|\*{3,}|_{3,})\s*$/.test(s)) return false
  if (/\|.*\|/.test(s)) return false
  return true
}

const DRAFT = /\b(drafts?|messages?|e-?mails?|slack|tweets?|posts?|repl(y|ies)|commits?|PRs?|descriptions?|paste|copy)\b/i

function labelOf(line: string): string | null {
  const t = line.trim()
  if (/^#{1,6}\s/.test(t)) return t
  if (/^(\*\*[^*]+\*\*|__[^_]+__):?$/.test(t)) return t
  if (t.length <= 160 && /:$/.test(t)) return t
  return null
}

export function splitBlocks(text: string): Block[] {
  const lines = linesOf(text)
  const blocks: Block[] = []
  let inDraft = false
  const push = (block: Block, own: readonly Line[], isFence: boolean) => {
    let touched = isFence && inDraft
    if (!isFence) {
      for (const l of own) {
        const label = labelOf(l.text)
        if (label !== null) inDraft = DRAFT.test(label)
        if (inDraft) touched = true
      }
    }
    blocks.push(touched ? { ...block, isProse: false } : block)
  }
  let i = 0
  while (i < lines.length) {
    const line = lines[i]!
    if (line.text.trim() === '') {
      i++
      continue
    }
    const fence = FENCE.exec(line.text)
    if (fence) {
      const mark = fence[1]!
      const close = new RegExp(`^\\s*${mark[0] === '`' ? '`' : '~'}{${mark.length},}\\s*$`)
      let j = i + 1
      while (j < lines.length && !close.test(lines[j]!.text)) j++
      const last = Math.min(j, lines.length - 1)
      push({ start: line.start, end: lines[last]!.end, isProse: false }, [], true)
      i = last + 1
      continue
    }
    let j = i
    while (j + 1 < lines.length && lines[j + 1]!.text.trim() !== '' && !FENCE.test(lines[j + 1]!.text)) j++
    const own = lines.slice(i, j + 1)
    push({ start: line.start, end: lines[j]!.end, isProse: own.every(l => isProseLine(l.text)) }, own, false)
    i = j + 1
  }
  return blocks
}

// ---------- inline parsing ----------

export type PieceKind = 'text' | 'bold' | 'italic' | 'code' | 'link' | 'url'
export type Piece = { kind: PieceKind; text: string; start: number; end: number; href?: string }

const INLINE =
  /``([^\n]+?)``|`([^`\n]+)`|\[([^\]\n]+)\]\(([^)\s]+)\)|\*\*([^*\n]+)\*\*|__([^_\n]+)__|(?<![\w*])\*([^*\s][^*\n]*?)\*(?![\w*])|(?<![\w_])_([^_\s][^_\n]*?)_(?![\w_])|(https?:\/\/[^\s)<>\]]+)/g

export function parseInline(content: string, base: number): Piece[] {
  const out: Piece[] = []
  let last = 0
  INLINE.lastIndex = 0
  for (let m = INLINE.exec(content); m !== null; m = INLINE.exec(content)) {
    if (m.index > last) out.push({ kind: 'text', text: content.slice(last, m.index), start: base + last, end: base + m.index })
    const start = base + m.index
    const end = start + m[0].length
    if (m[1] !== undefined || m[2] !== undefined) out.push({ kind: 'code', text: (m[1] ?? m[2])!, start, end })
    else if (m[3] !== undefined) out.push({ kind: 'link', text: m[3], href: m[4]!, start, end })
    else if (m[5] !== undefined || m[6] !== undefined) out.push({ kind: 'bold', text: (m[5] ?? m[6])!, start, end })
    else if (m[7] !== undefined || m[8] !== undefined) out.push({ kind: 'italic', text: (m[7] ?? m[8])!, start, end })
    else out.push({ kind: 'url', text: m[9]!, start, end })
    last = m.index + m[0].length
  }
  if (last < content.length) out.push({ kind: 'text', text: content.slice(last), start: base + last, end: base + content.length })
  return out
}

const MARKER = /^(\s*)([-*+]|\d{1,3}[.)])\s+/

export type ProseLine = { marker: string | null; indent: number; pieces: Piece[] }

export function proseLines(text: string, block: Block): ProseLine[] {
  const out: ProseLine[] = []
  for (const line of linesOf(text.slice(block.start, block.end))) {
    const abs = block.start + line.start
    const m = MARKER.exec(line.text)
    if (m) {
      const contentStart = m[0].length
      out.push({ marker: m[2]!, indent: m[1]!.length, pieces: parseInline(line.text.slice(contentStart), abs + contentStart) })
    } else {
      const lead = line.text.length - line.text.trimStart().length
      out.push({ marker: null, indent: 0, pieces: parseInline(line.text.slice(lead), abs + lead) })
    }
  }
  return out
}

export type Range = { start: number; end: number }

export function eligibleRanges(text: string): Range[] {
  const out: Range[] = []
  for (const block of splitBlocks(text)) {
    if (!block.isProse) continue
    for (const line of proseLines(text, block)) {
      for (const p of line.pieces) if (p.kind === 'text') out.push({ start: p.start, end: p.end })
    }
  }
  return out
}

// ---------- validating a model reply ----------

const WORD = /^[A-Za-z]+(?:['’-][A-Za-z]+)*$/
const LEAD_PUNCT = /^[("'“‘[]+/
const TRAIL_PUNCT = /[.,;:!?)"'”’\]]+$/
const CJK = /[㐀-鿿豈-﫿]/

function isPlainPhrase(en: string): boolean {
  if (en.length === 0 || en.length > 60) return false
  const words = en.split(' ')
  if (words.length > 5) return false
  return words.every(w => WORD.test(w) && !/[a-z][A-Z]/.test(w) && !/^[A-Z]{2,}$/.test(w))
}

function tokenAround(text: string, pos: number, range: Range): Range {
  let s = pos
  while (s > range.start && !/\s/.test(text[s - 1]!)) s--
  let e = pos
  while (e < range.end && !/\s/.test(text[e]!)) e++
  let token = text.slice(s, e)
  const lead = LEAD_PUNCT.exec(token)?.[0].length ?? 0
  token = token.slice(lead)
  const trail = TRAIL_PUNCT.exec(token)?.[0].length ?? 0
  return { start: s + lead, end: e - trail }
}

export function isSwappable(text: string, start: number, end: number, ranges: Range[]): boolean {
  const range = ranges.find(r => r.start <= start && end <= r.end)
  if (!range) return false
  if (!isPlainPhrase(text.slice(start, end))) return false
  const first = tokenAround(text, start, range)
  const last = tokenAround(text, end - 1, range)
  return first.start === start && last.end === end
}

function occurrences(text: string, needle: string): number[] {
  const out: number[] = []
  for (let i = text.indexOf(needle); i !== -1; i = text.indexOf(needle, i + needle.length)) out.push(i)
  return out
}

export function locate(text: string, en: string, occurrence: number, ranges: Range[]): number | null {
  const raw = occurrences(text, en)
  const atRaw = raw[occurrence - 1]
  if (atRaw !== undefined && isSwappable(text, atRaw, atRaw + en.length, ranges)) return atRaw
  const whole = raw.filter(i => !/[A-Za-z0-9_]/.test(text[i - 1] ?? ' ') && !/[A-Za-z0-9_]/.test(text[i + en.length] ?? ' '))
  const atWhole = whole[occurrence - 1]
  if (atWhole !== undefined && isSwappable(text, atWhole, atWhole + en.length, ranges)) return atWhole
  return null
}

function str(v: unknown, max = 200): string {
  return typeof v === 'string' ? v.trim().slice(0, max) : ''
}

export const STOPWORDS = new Set(
  'because but and or now again then already very also just still here there this that it the a an to of in on at for with so however basically first finally'.split(
    ' ',
  ),
)

export const LINKING = new Set('because but so however basically first then finally now also'.split(' '))

export function isClauseStart(text: string, start: number): boolean {
  const before = text.slice(Math.max(0, text.lastIndexOf('\n', start - 1) + 1), start)
  if (/^\s*(([-*+]|\d{1,3}[.)])\s+)?$/.test(before)) return true
  return /[.!?:;]\s+$/.test(before)
}

export function isWeakSwap(en: string, pos: string, atClauseStart = false): boolean {
  const lower = en.toLowerCase()
  if (STOPWORDS.has(lower)) return !(atClauseStart && LINKING.has(lower))
  const last = lower.split(' ').pop() ?? lower
  return /\bverb\b/i.test(pos) && isInflected(last)
}

const BASE_ED = new Set(['embed', 'shred', 'wed', 'bed', 'bred'])
const BASE_ING = new Set(['bring', 'sing', 'ring', 'swing', 'sting', 'string', 'cling', 'fling', 'wring'])

export function isInflected(word: string): boolean {
  if (word.endsWith('ing')) return word.length > 4 && !BASE_ING.has(word)
  if (word.endsWith('ed')) return word.length > 4 && !word.endsWith('eed') && !BASE_ED.has(word)
  if (word.endsWith('s')) return word.length > 2 && !/(ss|us)$/.test(word)
  return false
}

export type ParseOptions = {
  isMandarin: boolean
  known: ReadonlySet<string>
  cap: number
  maxPhrases?: number
  coverage?: OsmosisSettings['coverage']
}

export function phraseCap(level: OsmosisSettings['level'], coverage: OsmosisSettings['coverage']): number {
  return level === 'advanced' ? 2 : level === 'intermediate' || coverage === 'maximum' ? 1 : 0
}

export type ParseResult = { ok: true; words: OsmosisWord[] } | { ok: false; reason: string }

// JSON (the local provider) or a reply cut off by the token cap: keep complete items.
export function extractJson(reply: string): unknown {
  const t = reply.replace(/```(?:json)?/gi, '')
  const a = t.indexOf('[')
  if (a === -1) {
    try {
      const obj = JSON.parse(t.slice(t.indexOf('{'), t.lastIndexOf('}') + 1)) as { words?: unknown }
      return Array.isArray(obj.words) ? obj.words : undefined
    } catch {
      return undefined
    }
  }
  const tries = [t.slice(a, t.lastIndexOf(']') + 1)]
  for (let cut = t.lastIndexOf('}'); cut > a; cut = t.lastIndexOf('}', cut - 1)) tries.push(`${t.slice(a, cut + 1)}]`)
  for (const attempt of tries) {
    try {
      return JSON.parse(attempt)
    } catch {
      // a reply cut off mid-item: try the last complete item
    }
  }
  return undefined
}

// Haiku replies one item per line: kind|en|occurrence|target|pos|gloss.
export function parseItems(reply: string): Record<string, unknown>[] | null {
  const t = reply.trim()
  const out: Record<string, unknown>[] = []
  for (const line of t.split('\n')) {
    const f = line.split('|').map(x => x.trim())
    if (f.length === 6) out.push({ kind: f[0], en: f[1], occurrence: Number(f[2]), target: f[3], pos: f[4], gloss: f[5] })
  }
  if (out.length || /^(none|nothing)?\.?$/i.test(t)) return out
  const data = /[[{]/.test(t) ? extractJson(t) : undefined
  return Array.isArray(data) ? (data as Record<string, unknown>[]) : null
}

export function parseReply(reply: string, text: string, opts: ParseOptions): ParseResult {
  const data = parseItems(reply)
  if (!data) return { ok: false, reason: 'unparsed' }
  const ranges = eligibleRanges(text)
  const words: OsmosisWord[] = []
  const seenEn = new Set<string>()
  let knownUsed = 0
  let phrases = 0
  for (const o of data) {
    if (words.length >= MAX_SWAPS * 2) break
    const en = typeof o.en === 'string' ? o.en : ''
    const occurrence = Math.trunc(Number(o.occurrence ?? 1))
    const target = str(o.target, 24)
    if (!en || !target || !(occurrence >= 1)) continue
    if (opts.isMandarin ? !CJK.test(target) : target.toLowerCase() === en.toLowerCase()) continue
    if (seenEn.has(en.toLowerCase())) continue
    const isKnown = opts.known.has(target)
    if (isKnown && knownUsed >= 1) continue
    const enWords = en.split(' ').length
    const kind: 'word' | 'phrase' = o.kind === 'phrase' || enWords > 3 ? 'phrase' : 'word'
    if (kind === 'phrase' && (enWords < 2 || phrases >= (opts.maxPhrases ?? 0))) continue
    const start = locate(text, en, occurrence, ranges)
    if (start === null) continue
    if (kind === 'word' && opts.coverage !== 'maximum' && isWeakSwap(en, str(o.pos, 30), isClauseStart(text, start))) continue
    const end = start + en.length
    if (words.some(r => start < r.end && r.start < end)) continue
    const gloss = str(o.gloss, 60).split(/\s+/).slice(0, 5).join(' ')
    words.push({ en, occurrence, target, romanization: '', pos: str(o.pos, 30), gloss, literal: '', exampleTarget: '', exampleRomanization: '', exampleEn: '', level: null, start, end, kind })
    if (kind === 'phrase') phrases++
    seenEn.add(en.toLowerCase())
    if (isKnown) knownUsed++
  }
  const kept = spreadOut(words, text, Math.min(opts.cap, MAX_SWAPS)).slice(0, Math.min(opts.cap, MAX_SWAPS))
  return { ok: true, words: kept.sort((x, y) => x.start - y.start) }
}

// Joins chunk results in block offsets: one item per English word, at most `phrases` phrases and one known word.
export function mergeChunks(text: string, lists: readonly OsmosisWord[][], cap: number, phrases: number, known: ReadonlySet<string>): OsmosisWord[] {
  const ranges = eligibleRanges(text)
  const seen = new Set<string>()
  let p = 0
  let k = 0
  const all = lists.flat().filter(w => {
    const en = w.en.toLowerCase()
    if (seen.has(en) || !isSwappable(text, w.start, w.end, ranges)) return false
    if (w.kind === 'phrase' && ++p > phrases) return false
    if (known.has(w.target) && ++k > 1) return false
    return seen.add(en)
  })
  return spreadOut(all, text, cap).slice(0, cap).sort((x, y) => x.start - y.start)
}

// When picks bunch up at the start (none in the last third), keep at most ceil(cap/paragraphs)+1 per paragraph.
export function spreadOut(words: OsmosisWord[], text: string, cap: number): OsmosisWord[] {
  const paras = splitBlocks(text).filter(b => b.isProse)
  if (paras.length < 2 || words.length === 0) return words
  const from = paras[0]!.start
  const third = (paras[paras.length - 1]!.end - from) / 3
  const firstThird = words.filter(w => w.start < from + third).length
  if (words.some(w => w.start >= from + 2 * third) || firstThird <= words.length / 2) return words
  const per = paras.map(() => 0)
  return words.filter(w => ++per[paras.findIndex(b => w.start >= b.start && w.end <= b.end)]! <= Math.ceil(cap / paras.length) + 1)
}

// ---------- the prompt ----------

export const RULES = `You pick English words in one block of an AI reply (markdown) to show in a target language, so a learner picks up vocabulary while reading.
1. Pick only from plain prose. Skip text meant to be copied (drafts, messages, emails, commit or PR text), inline code, code fences, URLs, paths, identifiers, numbers, tables, headings, quotes, link text and bold text.
2. "en" is an exact, case-matched substring: a whole word or phrase, no punctuation around it. "occurrence" is which appearance of that string, counting from 1.
3. The learner reads the English sentence with your item in its place. Prefer nouns and noun phrases, then adjectives before a noun. Verbs only in base form (imperative, after "to" or a modal); never an inflected verb (expects, failed, running).
4. Never pick adverbs of time, frequency or degree, conjunctions, prepositions, pronouns, articles, particles or question words, except one linking word that opens a sentence or clause where Chinese also puts it first (because 因为, but 但是, so 所以, however 不过, basically 基本上, first 首先, then 然后, finally 最后, now 现在, also 另外).
5. The target has the same part of speech and sense as the English in this sentence.
6. A phrase replaces 2-5 words inside one clause with one natural phrase in target-language word order that drops cleanly into the sentence. Stay within the phrase limit; a phrase counts toward the item limit.
7. Pick obvious items fast; do not deliberate. Never exceed the item limit. Spread items evenly across paragraphs. Prefer review words.
8. Coverage maximum lifts rules 3-5: any part of speech, and awkward English word order is acceptable.
Output one item per line, fields separated by |, nothing else:
kind|en|occurrence|target|pos|gloss
kind is word or phrase; target in simplified hanzi for Mandarin; gloss is at most 4 English words. If nothing fits, output nothing.
word|computer|1|电脑|noun|computer
phrase|run the test again|1|再运行测试|phrase|run the test again`

export const LOCAL_NOTE = '\nReply instead as a JSON array of objects with those six fields, matching the schema.'

const LEVEL_RULES: Record<OsmosisLevel, string> = {
  beginner: 'beginner: HSK 1-2 (CEFR A1-A2) nouns and base verbs, single words; a common concrete HSK 3 noun only if nothing else fits.',
  intermediate: 'intermediate: HSK 3-4 (B1-B2) nouns, noun phrases, adjectives before a noun, base verbs.',
  advanced: 'advanced: HSK 5-6 (C1-C2) words; idioms (成语) where natural.',
}

const PER_SENTENCE: Record<OsmosisDensity, number> = { low: 1 / 3, normal: 1, high: 2 }

export type Chunk = { start: number; end: number; sentences: number }

const sentencesIn = (body: string) => Math.max(body.match(/[.!?](\s|$)/g)?.length ?? 0, body.split('\n').filter(l => l.trim() !== '').length)

// Groups prose paragraphs into chunks of about `size` sentences; splits only a paragraph over `max`.
export function chunkBlock(text: string, size = 7, max = 10): Chunk[] {
  const parts: Chunk[] = []
  for (const b of splitBlocks(text).filter(x => x.isProse)) {
    const n = sentencesIn(text.slice(b.start, b.end))
    if (n <= max) {
      parts.push({ start: b.start, end: b.end, sentences: n })
      continue
    }
    const ends = [...text.slice(b.start, b.end).matchAll(/[.!?](\s+|$)/g)].map(m => b.start + m.index! + m[0].length)
    for (let i = 0, from = b.start; i < ends.length; i += size) {
      const to = i + size >= ends.length ? b.end : ends[i + size - 1]!
      parts.push({ start: from, end: to, sentences: Math.min(size, ends.length - i) })
      from = to
    }
  }
  const out: Chunk[] = []
  for (const p of parts) {
    const last = out[out.length - 1]
    if (last && last.sentences + p.sentences <= size + 1) out[out.length - 1] = { start: last.start, end: p.end, sentences: last.sentences + p.sentences }
    else out.push(p)
  }
  return out
}

export function countSentences(text: string): number {
  let n = 0
  for (const block of splitBlocks(text)) {
    if (!block.isProse) continue
    n += sentencesIn(text.slice(block.start, block.end))
  }
  return n
}

export function swapCap(text: string, density: OsmosisDensity): number {
  const n = countSentences(text)
  return n === 0 ? 0 : Math.max(1, Math.min(MAX_SWAPS, Math.ceil(n * PER_SENTENCE[density])))
}

export function reviewWords(progress: OsmosisProgress): string[] {
  const review = Object.entries(progress.seen)
    .filter(([t, s]) => s.n >= 3 && !progress.known[t] && !progress.saved[t])
    .sort((a, b) => b[1].n - a[1].n)
    .map(([t]) => t)
  return [...Object.keys(progress.saved).slice(-8), ...review].slice(0, 15)
}

export function buildPrompt(text: string, s: OsmosisSettings, review: readonly string[], cap: number): string {
  const info = langInfo(s.lang)
  return [
    `Target: ${info.isMandarin ? 'Mandarin Chinese (simplified)' : info.name}`,
    `Level: ${LEVEL_RULES[s.level]}`,
    `Item limit: ${cap}; phrase limit: ${phraseCap(s.level, s.coverage)}; coverage: ${s.coverage}`,
    review.length ? `Review words: ${review.join(', ')}` : '',
    '<<<',
    text,
    '>>>',
  ]
    .filter(Boolean)
    .join('\n')
}

// ---------- speech ----------

export function pickVoice(listing: string): string | undefined {
  const lines = listing.split('\n')
  if (lines.some(l => /^Ting-?Ting\b/i.test(l))) return 'Tingting'
  const zh = lines.find(l => /\szh_CN\s/.test(l))
  return zh ? /^(.+?)\s+[a-z]{2,3}_[A-Z]{2,}\s/.exec(zh)?.[1]?.trim() : undefined
}

// ---------- drawing helpers ----------

export type ShowPart = 'hanzi' | 'pinyin' | 'english'
export const SHOW_PARTS: readonly (readonly [ShowPart, string])[] = [['hanzi', 'Hanzi'], ['pinyin', 'Pinyin'], ['english', 'English']]

// What a swapped word shows; the target word itself (hanzi, else pinyin) is never left out.
export function showParts(show: OsmosisSettings['show']): Set<ShowPart> {
  const parts = new Set((show === 'both' ? 'hanzi+pinyin' : show).split('+').filter((p): p is ShowPart => SHOW_PARTS.some(([k]) => k === p)))
  if (!parts.has('hanzi') && !parts.has('pinyin')) parts.add('hanzi')
  return parts
}

export function showValue(parts: ReadonlySet<ShowPart>): string {
  return SHOW_PARTS.map(([k]) => k).filter(k => parts.has(k)).join('+') || 'hanzi'
}

// Toggles one part, keeping hanzi or pinyin on.
export function toggleShow(show: OsmosisSettings['show'], part: ShowPart): string {
  const parts = showParts(show)
  if (parts.has(part)) parts.delete(part)
  else parts.add(part)
  if (!parts.has('hanzi') && !parts.has('pinyin')) return showValue(showParts(show))
  return showValue(parts)
}

export function showLabel(show: OsmosisSettings['show']): string {
  const parts = showParts(show)
  return SHOW_PARTS.filter(([k]) => parts.has(k)).map(([, label]) => label).join(' + ')
}

export function shownText(w: OsmosisWord, show: OsmosisSettings['show']): string {
  if (!showParts(show).has('hanzi') && w.romanization) return w.romanization
  return w.target
}

// The parts drawn dim after the word: its pinyin beside hanzi, then the English.
export function shownExtras(w: OsmosisWord, show: OsmosisSettings['show']): string[] {
  const parts = showParts(show)
  return [parts.has('hanzi') && parts.has('pinyin') ? w.romanization : '', parts.has('english') && w.en ? `(${w.en})` : ''].filter(Boolean)
}

export function shownFull(w: OsmosisWord, show: OsmosisSettings['show']): string {
  return [shownText(w, show), ...shownExtras(w, show)].join(' ')
}

let dayOffsetMin = 0

export function setDayOffset(minutesEastOfUtc: number) {
  if (Number.isFinite(minutesEastOfUtc) && Math.abs(minutesEastOfUtc) <= 14 * 60) dayOffsetMin = minutesEastOfUtc
}

export function parseUtcOffset(s: string): number | null {
  const m = /^([+-])(\d{2})(\d{2})$/.exec(s.trim())
  if (!m) return null
  return (m[1] === '-' ? -1 : 1) * (Number(m[2]) * 60 + Number(m[3]))
}

export function msToNextDay(ms: number): number {
  return 86_400_000 - ((ms + dayOffsetMin * 60_000) % 86_400_000) + 1000
}

export function dayOf(ms: number): string {
  return new Date(ms + dayOffsetMin * 60_000).toISOString().slice(0, 10)
}

const chWidth = (ch: string) => (/[ᄀ-ᅟ⺀-꓏가-힣豈-﫿︰-﹏＀-｠￠-￦]/.test(ch) ? 2 : 1)

export function cellWidth(s: string): number {
  let n = 0
  for (const ch of s) n += chWidth(ch)
  return n
}

// One pass: cut to `cells` (with an ellipsis when cut) or pad with spaces to `cells`.
export function fitCells(s: string, cells: number, mode: 'pad' | 'cut'): string {
  const room = mode === 'cut' && cellWidth(s) > cells ? cells - 1 : cells
  let out = ''
  let w = 0
  for (const ch of s) {
    const cw = chWidth(ch)
    if (w + cw > room) return mode === 'cut' ? `${out}\u2026` : out + ' '.repeat(cells - w)
    out += ch
    w += cw
  }
  return mode === 'cut' ? out : out + ' '.repeat(cells - w)
}

// ---------- planning a translated message ----------

export type Part = { text: string; kind: PieceKind; href?: string }
export type Token = { kind: 'parts'; parts: Part[] } | { kind: 'swap'; index: number; trailing: string }
export type DrawLine = { marker: string | null; indent: number; tokens: Token[] }
export type Segment = { kind: 'md'; text: string } | { kind: 'prose'; lines: DrawLine[] }

function tokenizeLine(text: string, line: ProseLine, words: readonly OsmosisWord[]): DrawLine {
  const tokens: Token[] = []
  let cur: Part[] | null = null
  const flush = () => {
    if (cur && cur.length) tokens.push({ kind: 'parts', parts: cur })
    cur = null
  }
  const pushText = (s: string, kind: PieceKind, href?: string) => {
    for (const chunk of s.match(/\S+\s*|\s+/g) ?? []) {
      const part: Part = href === undefined ? { text: chunk, kind } : { text: chunk, kind, href }
      if (/^\s+$/.test(chunk)) {
        if (cur) {
          cur.push(part)
          flush()
        } else {
          const last = tokens[tokens.length - 1]
          if (last?.kind === 'swap') last.trailing += chunk
        }
        continue
      }
      if (!cur) cur = []
      cur.push(part)
      if (/\s$/.test(chunk)) flush()
    }
  }
  for (const piece of line.pieces) {
    if (piece.kind !== 'text') {
      pushText(piece.text, piece.kind, piece.href)
      continue
    }
    let cursor = piece.start
    words.forEach((w, index) => {
      if (w.start < piece.start || w.end > piece.end) return
      pushText(text.slice(cursor, w.start), 'text')
      flush()
      tokens.push({ kind: 'swap', index, trailing: '' })
      cursor = w.end
    })
    pushText(text.slice(cursor, piece.end), 'text')
  }
  flush()
  return { marker: line.marker, indent: line.indent, tokens }
}

export function planMessage(text: string, words: readonly OsmosisWord[]): Segment[] {
  const segs: Segment[] = []
  let mdStart: number | null = null
  let mdEnd = 0
  const flushMd = () => {
    if (mdStart === null) return
    const body = text.slice(mdStart, mdEnd).replace(/\s+$/, '')
    if (body) segs.push({ kind: 'md', text: body })
    mdStart = null
  }
  for (const block of splitBlocks(text)) {
    const hasSwap = words.some(w => w.start >= block.start && w.end <= block.end)
    if (block.isProse && hasSwap) {
      flushMd()
      segs.push({ kind: 'prose', lines: proseLines(text, block).map(l => tokenizeLine(text, l, words)) })
    } else {
      if (mdStart === null) mdStart = block.start
      mdEnd = block.end
    }
  }
  flushMd()
  return segs
}

// ---------- floating card placement ----------

export type SwapSpot = { row: number; x: number; avail: number; lineLeft: number; lineRow?: number }
export type SwapLayout = { spots: Map<number, SwapSpot>; rows: number }

function tokenWidth(t: Token, words: readonly OsmosisWord[], show: OsmosisSettings['show'], buttonCells: number): number {
  if (t.kind === 'parts') return cellWidth(t.parts.map(p => p.text).join(''))
  // The word is one button, and its dimmed reading a second one.
  const w = words[t.index]!
  const buttons = shownExtras(w, show).length ? 2 : 1
  return cellWidth(shownFull(w, show)) + cellWidth(t.trailing) + buttons * buttonCells
}

// Markdown draws no code fences or emphasis marks; a table row gets a rule under it.
export function mdRows(text: string, body: number): number {
  let rows = 0
  let inTable = false
  for (const line of text.split('\n')) {
    if (/^\s*(```|~~~)/.test(line)) continue
    const isTable = /^\s*\|/.test(line)
    if (isTable && !inTable) rows += 1
    inTable = isTable
    if (isTable) {
      if (!/^\s*\|?[\s:|-]+\|?\s*$/.test(line)) rows += 2
      continue
    }
    rows += Math.max(1, Math.ceil(cellWidth(line.replace(/\*\*|__|`/g, '').replace(/^#{1,6} /, '')) / body))
  }
  return rows
}

export function placeSwaps(
  segs: readonly Segment[],
  words: readonly OsmosisWord[],
  show: OsmosisSettings['show'],
  columns: number,
  buttonCells = 0,
): SwapLayout {
  const spots = new Map<number, SwapSpot>()
  const body = Math.max(10, columns - 2)
  let row = 0
  segs.forEach((seg, si) => {
    if (si > 0) row += 1
    if (seg.kind === 'md') {
      row += mdRows(seg.text, body)
      return
    }
    for (const line of seg.lines) {
      const lineLeft = line.indent + (line.marker === null ? 0 : line.marker.length + 1)
      const avail = Math.max(8, body - lineLeft)
      let x = 0
      let lineRow = 0
      for (const t of line.tokens) {
        const w = tokenWidth(t, words, show, buttonCells)
        if (x > 0 && x + w > avail) {
          row++
          lineRow++
          x = 0
        }
        if (t.kind === 'swap') spots.set(t.index, { row, x, avail, lineLeft, lineRow })
        x += w
      }
      row++
    }
  })
  return { spots, rows: row }
}

export const CARD_MAX = 40
// The card's first row ends in a speaker button: a space and a wide glyph.
export const SPEAKER = '\u{1F50A}'
const SPEAKER_CELLS = 3

export function cardLines(w: OsmosisWord): string[] {
  return [
    `${w.target}  ${w.romanization}`.trim(),
    [w.pos, w.gloss].filter(Boolean).join(' \u00b7 '),
    w.literal,
    [w.level ? `HSK ${w.level}` : '', w.verified === true ? '\u2713' : w.verified === false ? 'unverified' : '', 'click for more'].filter(Boolean).join(' \u00b7 '),
  ].filter(Boolean)
}

// Wraps at spaces; a continuation row is indented, and one word too wide is cut.
export function wrapCells(s: string, cells: number, indent = 2): string[] {
  const rows: string[] = []
  let cur = ''
  for (const word of s.split(' ')) {
    const next = cur ? `${cur} ${word}` : word
    if (cellWidth(next) <= cells || !cur.trim()) cur = next
    else {
      rows.push(cur)
      cur = ' '.repeat(indent) + word
    }
  }
  rows.push(cur)
  return rows.map(r => fitCells(r, cells, 'cut'))
}

export type CardRow = { text: string; line: number }

export function cardRows(lines: readonly string[], inner: number): CardRow[] {
  return lines.flatMap((l, line) => wrapCells(l, line === 0 ? inner - SPEAKER_CELLS : inner).map(text => ({ text, line })))
}

export type CardPlace =
  | { kind: 'above' | 'below'; top: number; left: number; inner: number; height: number; edge: 'left' | 'right'; shift?: number; spare?: number }
  | { kind: 'bar' }

export type OnScreenRows = { first: number; last: number } | null | undefined

const GUTTER = 2

// Rows are content rows of the message; the site adds one margin row above them.
export function placeCard(
  spot: SwapSpot,
  lines: readonly string[],
  totalRows: number,
  onScreen: OnScreenRows,
  columns: number,
  isPinned = false,
): CardPlace {
  const widest = Math.max(...lines.map((l, i) => cellWidth(l) + (i === 0 ? SPEAKER_CELLS : 0)))
  const inner = Math.max(4, Math.min(widest, CARD_MAX - 4, columns - GUTTER - 4))
  const width = inner + 4
  const height = cardRows(lines, inner).length + 2
  const left = Math.max(0, Math.min(GUTTER + spot.lineLeft + spot.x, columns - width))
  // A graphical surface pins the card to the word, so it only needs the side with room.
  const edge = GUTTER + spot.lineLeft + spot.x + width > columns ? 'right' : 'left'
  const site = (row: number) => row + 1
  const aboveTop = spot.row - height
  if (isPinned) return placePinned(spot, totalRows, columns, inner, height)
  if (aboveTop >= 0 && (!onScreen || site(aboveTop) >= onScreen.first)) return { kind: 'above', top: aboveTop, left, inner, height, edge }
  const belowTop = spot.row + 1
  const belowEnd = belowTop + height - 1
  if (belowEnd < totalRows && (!onScreen || site(belowEnd) <= onScreen.last)) return { kind: 'below', top: belowTop, left, inner, height, edge }
  // Fullscreen clips to the viewport, so a short message's card may cover the reply above.
  if (onScreen && onScreen.first === 0) return { kind: 'above', top: aboveTop, left, inner, height, edge }
  return { kind: 'bar' }
}

// A graphical surface sets text in a proportional font: a character averages about 0.8 of
// the cell its boxes are measured in.
const TEXT_CELLS = 0.8
// It also pads each word button, about this many text cells across both sides.
const BUTTON_CELLS = 2
// A word the line still holds at this much of its estimated width is taken to be on that row.
const SURE_WIDTH = 0.9

// A graphical surface clips a floating card to its message, so the card goes above the word when
// the message has room for it there, else below; a message too short for it keeps spare rows under
// itself, so every word gets the whole card.
function placePinned(spot: SwapSpot, totalRows: number, columns: number, inner: number, height: number): CardPlace {
  const x = Math.round((spot.lineLeft + spot.x) * TEXT_CELLS)
  const room = Math.floor(columns * TEXT_CELLS)
  // `left` is from the message's left edge (a card below is drawn there); `shift` is from the
  // word's left edge (a card above is pinned to the word), moved left only as far as it must.
  const start = Math.max(0, Math.min(x, room - inner - 4))
  const at = { edge: 'left' as const, left: GUTTER + start, shift: start - x }
  if (spot.row >= height) return { kind: 'above', top: spot.row - height, inner, height, ...at }
  const below = totalRows - spot.row - 1
  return { kind: 'below', top: spot.row + 1, inner, height, ...at, ...(below < height ? { spare: height - below } : {}) }
}

export function planCards(
  segs: readonly Segment[],
  words: readonly OsmosisWord[],
  show: OsmosisSettings['show'],
  columns: number,
  onScreen: OnScreenRows,
  isPinned = false,
): Map<number, CardPlace> {
  // A graphical surface fits more text on a line than its cell count says, less its button padding.
  const text = Math.floor(columns / TEXT_CELLS)
  const layout = isPinned ? placeSwaps(segs, words, show, text, BUTTON_CELLS) : placeSwaps(segs, words, show, columns)
  // The estimate is rough. A word that a slightly narrower line would wrap is placed as if it starts
  // the next row: a card placed for the end of the row above would cover that row's text, and one
  // moved left to fit would slide out of the message, leaving only its blank end over the reply.
  const tight = isPinned ? placeSwaps(segs, words, show, Math.floor(text * SURE_WIDTH), BUTTON_CELLS) : null
  const plans = new Map<number, CardPlace>()
  for (const [index, spot] of layout.spots) {
    const t = tight?.spots.get(index)
    const at = t && t.lineRow !== spot.lineRow ? { ...spot, row: spot.row + (t.lineRow ?? 0) - (spot.lineRow ?? 0), x: t.x } : spot
    plans.set(index, placeCard(at, cardLines(words[index]!), layout.rows, onScreen, columns, isPinned))
  }
  return plans
}

export const padCells = (s: string, cells: number) => fitCells(s, cells, 'pad')

// ---------- which blocks to translate ----------

export function normText(s: string): string {
  return s.replace(/\s+/g, ' ').trim()
}

export function isFinalBlock(text: string, finals: readonly string[]): boolean {
  const n = normText(text)
  if (n.length === 0) return false
  return finals.some(f => f === n || (n.length >= MIN_CHARS && f.endsWith(n)))
}

export type HistoryRow = { role: 'user' | 'assistant'; text: string; toolUses: readonly unknown[]; toolResults?: readonly unknown[] }

export function finalsFromHistory(rows: readonly HistoryRow[]): string[] {
  return rawFinalsFromHistory(rows).map(normText)
}

export function rawFinalsFromHistory(rows: readonly HistoryRow[]): string[] {
  const out: string[] = []
  let last = ''
  for (const row of rows) {
    if (row.role === 'assistant') {
      if (row.toolUses.length > 0) last = ''
      else if (row.text.trim()) last = row.text
    } else if (!row.toolResults || row.toolResults.length === 0) {
      if (last) out.push(last)
      last = ''
    }
  }
  if (last) out.push(last)
  return out
}

// ---------- the settings table: pane rows, commands and help share it ----------

export type SettingRow = {
  command: string
  keyName: string
  label: string
  key: keyof OsmosisSettings
  values: readonly (readonly [string, string, string | boolean])[]
  help: string
}

export const SETTING_ROWS: readonly SettingRow[] = [
  { command: 'on|off', keyName: 'set', label: 'Osmosis', key: 'isOn', values: [['on', 'On', true], ['off', 'Off', false]], help: 'Turn all translation on or off.' },
  { command: 'level', keyName: 'level', label: 'Level', key: 'level', values: [['beginner', 'Beginner', 'beginner'], ['intermediate', 'Intermediate', 'intermediate'], ['advanced', 'Advanced', 'advanced']], help: 'Which words swap: HSK 1-2, 3-4, or 5-6.' },
  { command: 'density', keyName: 'density', label: 'Density', key: 'density', values: [['low', 'Low', 'low'], ['normal', 'Normal', 'normal'], ['high', 'High', 'high']], help: 'How many words swap: 1 per 3 sentences, 1, or 2 per sentence.' },
  { command: 'show', keyName: 'show', label: 'Show', key: 'show', values: [['hanzi', 'Hanzi', 'hanzi'], ['pinyin', 'Pinyin', 'pinyin'], ['english', 'English', 'english']], help: 'What each swapped word shows: any mix of characters, pinyin and English.' },
  { command: 'coverage', keyName: 'coverage', label: 'Coverage', key: 'coverage', values: [['natural', 'Natural', 'natural'], ['maximum', 'Maximum', 'maximum']], help: 'Natural keeps English grammar intact; Maximum swaps more words.' },
  { command: 'card', keyName: 'card', label: 'Hover card', key: 'card', values: [['word', 'At the word', 'word'], ['bar', 'In the bar', 'bar'], ['both', 'Both', 'both']], help: 'Where the word card appears when you point at a word.' },
  { command: 'band', keyName: 'bar', label: 'Hover bar', key: 'isBandOn', values: [['on', 'On', true], ['off', 'Off', false]], help: "The line above the prompt with today's count and bar cards." },
  { command: 'status', keyName: 'status', label: 'Status line', key: 'isStatusOn', values: [['on', 'On', true], ['off', 'Off', false]], help: 'The \u{1F331} entry under the prompt.' },
  { command: 'focus', keyName: 'focus', label: 'Focus pane', key: 'isFocusOn', values: [['on', 'On', true], ['off', 'Off', false]], help: 'Clicking a word moves the keyboard to the pane, so its keys work at once.' },
  { command: 'copy', keyName: 'copy', label: 'Copy', key: 'copy', values: [['english', 'English', 'english'], ['shown', 'As shown', 'shown']], help: 'English pastes copied text in English; As shown does not.' },
  { command: 'cap', keyName: 'cap', label: 'Daily cap', key: 'cap', values: [['off', 'Off', 'off'], ['100k', '100k', '100k'], ['300k', '300k', '300k'], ['1m', '1M', '1m']], help: 'Stop translating after this many Haiku tokens a day.' },
  { command: 'model', keyName: 'model', label: 'Model', key: 'model', values: [['haiku', 'Haiku', 'haiku'], ['local', 'Local', 'local']], help: 'Haiku (default) or a local model on your machine.' },
]

export function settingsHelp(): string {
  const lines = ['Osmosis settings (type /osmosis <setting> <value>, or use the pane):']
  for (const row of SETTING_ROWS) {
    const values = row.values.map(v => v[0]).join('|')
    const usage = row.command === 'on|off' ? 'on|off' : row.key === 'show' ? 'show hanzi+pinyin+english (any mix; or show +english / -english)' : `${row.command} ${values}`
    lines.push(`- ${usage}: ${row.help}`)
  }
  lines.push('- endpoint <url>: Address of the local model server (default http://127.0.0.1:8080/v1).')
  lines.push('- local-model <name>: Model name sent to the local server (Ollama, LM Studio).')
  lines.push('- lang <name>: Target language; Mandarin is the default and tested one.')
  lines.push('- debug on|off: Write a trace of keys and counts (no reply text) to a log file.')
  lines.push('- export [all]: Save new saved words (or all) as an Anki deck in Downloads.')
  lines.push('Other: /osmosis (open the pane), /osmosis close, /osmosis bank, /osmosis quiz.')
  return lines.join('\n')
}

// ---------- Anki export ----------

export type AnkiNote = { hanzi: string; pinyin: string; meaning: string; example: string; exampleEn: string; audio: string; exampleAudio: string }

const TONE_MARKS = ['āēīōūǖ', 'áéíóúǘ', 'ǎěǐǒǔǚ', 'àèìòùǜ']
const VOWELS = `aeiouüv${TONE_MARKS.join('')}`
const SYLLABLE = new RegExp(`(?:[zcs]h|[bpmfdtnlgkhjqxrzcsyw])?[${VOWELS}]+(?:ng|n|r)?(?![${VOWELS}])`, 'iy')

const escapeHtml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

function toneOf(syllable: string): number {
  const at = TONE_MARKS.findIndex(marks => [...syllable.toLowerCase()].some(ch => marks.includes(ch)))
  return at === -1 ? 5 : at + 1
}

// Wraps each pinyin syllable in a tone span (t1-t5); pinyin it cannot split stays plain.
export function toneSpans(pinyin: string): string {
  const text = pinyin.normalize('NFC')
  const out: string[] = []
  for (let i = 0; i < text.length; ) {
    SYLLABLE.lastIndex = i
    const m = SYLLABLE.exec(text)
    if (m) {
      out.push(`<span class="t${toneOf(m[0])}">${m[0]}</span>`)
      i += m[0].length
    } else if (/\p{L}/u.test(text[i]!)) {
      return escapeHtml(text)
    } else {
      out.push(escapeHtml(text[i]!))
      i++
    }
  }
  return out.join('')
}

// Mandarin only: the cards use Chinese voices and tone colors, and a bank can hold other languages.
export function exportWords(progress: OsmosisProgress, isAll: boolean): OsmosisWord[] {
  return Object.values(progress.saved).filter(w => CJK.test(w.target) && (isAll || !progress.exported[w.target]))
}

export function ankiNotes(words: readonly OsmosisWord[]): AnkiNote[] {
  return words.map(w => ({
    hanzi: escapeHtml(w.target),
    pinyin: toneSpans(w.romanization),
    meaning: escapeHtml(w.gloss),
    example: escapeHtml(w.exampleTarget),
    exampleEn: escapeHtml(w.exampleEn),
    audio: audioName(w.target),
    exampleAudio: audioName(w.exampleTarget),
  }))
}

// Named by the text, so a re-export reuses the mp3 and Anki keeps one copy.
export function audioName(text: string): string {
  return text ? `osmosis-${hashText(text)}.mp3` : ''
}

export function ttsClips(words: readonly OsmosisWord[]): { text: string; name: string }[] {
  const texts = new Set(words.flatMap(w => [w.target, w.exampleTarget]).filter(Boolean))
  return [...texts].map(text => ({ text, name: audioName(text) }))
}

// The pane key a keystroke into the prompt stands for: one of the pane's keys typed into an empty box.
// The terminal reports the draft before the key and the key typed; the desktop app reports the draft
// with the key already in it and nothing typed.
const PANE_KEYS = new Set(['s', 'b', 'k', 'n', 'p', 'x'])

export function promptPaneKey(draft: string, typed: string): string | null {
  if (draft === '' && PANE_KEYS.has(typed)) return typed
  if (typed === '' && PANE_KEYS.has(draft)) return draft
  return null
}
