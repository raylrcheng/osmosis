import { describe, expect, test } from 'claude-code/testing'

import {
  eligibleRanges,
  isSwappable,
  keyFor,
  locate,
  parseReply,
  pickVoice,
  planMessage,
  splitBlocks,
  swapCap,
  DEFAULT_SETTINGS,
} from '../hooks/core'

const TEXT = [
  'I opened the computer and read the file. Then I wrote a short note for you.',
  '',
  '```ts',
  'const computer = 1',
  '',
  'note(computer)',
  '```',
  '',
  'Run `computer --help` or open src/computer.ts to see more.',
].join('\n')

const at = (text: string, needle: string, n = 1) => {
  let i = -1
  for (let k = 0; k < n; k++) i = text.indexOf(needle, i + 1)
  return i
}

const item = (en: string, occurrence: number, target: string) => ({
  en,
  occurrence,
  target,
  romanization: 'x',
  pos: 'noun',
  gloss: en,
  literal: '',
  example_target: '',
  example_romanization: '',
  example_en: '',
  level: 1,
})

const OPTS = { isMandarin: true, known: new Set<string>(), cap: 12 }

describe('block splitter', () => {
  test('a code fence with blank lines inside is one non-prose block', () => {
    const blocks = splitBlocks(TEXT)
    expect(blocks.map(b => b.isProse)).toEqual([true, false, true])
    expect(TEXT.slice(blocks[1]!.start, blocks[1]!.end)).toContain('note(computer)')
  })

  test('headings, quotes, tables and indented code are not prose', () => {
    const t = '# Title words here\n\n> quoted words\n\n| a | b |\n|---|---|\n\n    indented code\n\nPlain words here.'
    expect(splitBlocks(t).map(b => b.isProse)).toEqual([false, false, false, false, true])
  })

  test('bullet lists count as prose', () => {
    expect(splitBlocks('- first item\n- second item\n1. third item').map(b => b.isProse)).toEqual([true])
  })
})

describe('tokenizer and eligibility', () => {
  test('code fences, inline code and file paths never get swaps', () => {
    const ranges = eligibleRanges(TEXT)
    const inFence = at(TEXT, 'computer', 2)
    const inCode = at(TEXT, 'computer', 4)
    const inPath = at(TEXT, 'computer', 5)
    expect(isSwappable(TEXT, inFence, inFence + 8, ranges)).toBe(false)
    expect(isSwappable(TEXT, inCode, inCode + 8, ranges)).toBe(false)
    expect(isSwappable(TEXT, inPath, inPath + 8, ranges)).toBe(false)
    const prose = at(TEXT, 'computer', 1)
    expect(isSwappable(TEXT, prose, prose + 8, ranges)).toBe(true)
  })

  test('occurrence maps to the right substring', () => {
    const t = 'The cat sat down. A cat ran off. That category is new.'
    const r = eligibleRanges(t)
    expect(locate(t, 'cat', 1, r)).toBe(at(t, 'cat', 1))
    expect(locate(t, 'cat', 2, r)).toBe(at(t, 'cat', 2))
    expect(locate(t, 'cat', 3, r)).toBe(null)
  })

  test('an occurrence that points into inline code is dropped, never moved into code', () => {
    const t = 'Use `cat` here. The cat sleeps all day long.'
    const r = eligibleRanges(t)
    expect(locate(t, 'cat', 1, r)).toBe(null)
    expect(locate(t, 'cat', 2, r)).toBe(at(t, 'cat', 2))
  })

  test('identifiers, acronyms and partial words are refused', () => {
    const t = 'The fooBar helper and the API call help the reader a lot.'
    const r = eligibleRanges(t)
    expect(locate(t, 'fooBar', 1, r)).toBe(null)
    expect(locate(t, 'API', 1, r)).toBe(null)
    expect(locate(t, 'hel', 1, r)).toBe(null)
    expect(locate(t, 'reader', 1, r)).toBe(at(t, 'reader'))
  })
})

describe('model reply validation', () => {
  test('a good reply resolves offsets in order', () => {
    const reply = JSON.stringify([item('note', 1, '笔记'), item('computer', 1, '电脑')])
    const r = parseReply(reply, TEXT, OPTS)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.words.map(w => w.target)).toEqual(['电脑', '笔记'])
    expect(TEXT.slice(r.words[0]!.start, r.words[0]!.end)).toBe('computer')
    expect(r.words[0]!.start).toBe(at(TEXT, 'computer', 1))
  })

  test('a reply wrapped in a code fence with prose around it still parses', () => {
    const reply = 'Here you go:\n```json\n' + JSON.stringify([item('computer', 1, '电脑')]) + '\n```'
    const r = parseReply(reply, TEXT, OPTS)
    expect(r.ok && r.words.length).toBe(1)
  })

  test('a malformed reply fails', () => {
    expect(parseReply('[{"en": "computer", ', TEXT, OPTS).ok).toBe(false)
    expect(parseReply('no json here', TEXT, OPTS).ok).toBe(false)
  })

  test('a wrong substring, a missing hanzi or a code-only word is dropped', () => {
    const reply = JSON.stringify([
      item('keyboard', 1, '键盘'),
      item('opened', 1, 'opened'),
      item('Run', 1, '运行'),
      item('computer', 2, '电脑'),
      item('short', 1, '短'),
    ])
    const r = parseReply(reply, TEXT, OPTS)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.words.map(w => w.en)).toEqual(['short', 'Run'])
  })

  test('at most one known word per block, and the cap holds', () => {
    const reply = JSON.stringify([item('opened', 1, '打开'), item('read', 1, '读'), item('wrote', 1, '写'), item('note', 1, '笔记')])
    const r = parseReply(reply, TEXT, { isMandarin: true, known: new Set(['打开', '读']), cap: 2 })
    expect(r.ok && r.words.map(w => w.target)).toEqual(['打开', '写'])
  })
})

describe('planning a message', () => {
  test('code stays markdown; the prose block gets a swap token', () => {
    const r = parseReply(JSON.stringify([item('computer', 1, '电脑')]), TEXT, OPTS)
    if (!r.ok) throw new Error('parse failed')
    const segs = planMessage(TEXT, r.words)
    expect(segs.map(s => s.kind)).toEqual(['prose', 'md'])
    const md = segs[1]
    expect(md?.kind === 'md' && md.text.startsWith('```ts')).toBe(true)
    const prose = segs[0]
    if (prose?.kind !== 'prose') throw new Error('no prose')
    const swaps = prose.lines[0]!.tokens.filter(t => t.kind === 'swap')
    expect(swaps).toHaveLength(1)
  })

  test('the cache key changes with level, and density sets the cap', () => {
    expect(keyFor(TEXT, DEFAULT_SETTINGS)).not.toBe(keyFor(TEXT, { ...DEFAULT_SETTINGS, level: 'advanced' }))
    expect(swapCap('One. Two. Three. Four. Five. Six.', 'low')).toBe(2)
    expect(swapCap('One. Two. Three.', 'high')).toBe(6)
  })
})

describe('voice pick', () => {
  test('prefers Tingting, else the first zh_CN voice', () => {
    const flo = 'Flo (Chinese (China mainland)) zh_CN    # 你好！我叫Flo。'
    const ting = 'Tingting (Chinese (China mainland)) zh_CN    # 你好！我叫婷婷。'
    expect(pickVoice(['Samantha            en_US    # Hello', flo, ting].join('\n'))).toBe('Tingting')
    expect(pickVoice(['Samantha            en_US    # Hello', flo].join('\n'))).toBe('Flo (Chinese (China mainland))')
    expect(pickVoice('Samantha            en_US    # Hello')).toBe(undefined)
  })
})

import { finalsFromHistory, isFinalBlock, RULES } from '../hooks/core'
import { literalFor, parseCedict, parseHsk, verifyWord } from '../hooks/dict'
import { addUsage, EMPTY_USAGE, isCapReached, localRequest, parseLocalReply, usageLines } from '../hooks/providers'

describe('which block is translated', () => {
  test('only the last text of each reply counts as final', () => {
    const rows = [
      { role: 'user' as const, text: 'fix it', toolUses: [] },
      { role: 'assistant' as const, text: 'Now checking the build logs for you.', toolUses: [] },
      { role: 'assistant' as const, text: '', toolUses: [{ name: 'Bash' }] },
      { role: 'user' as const, text: '', toolUses: [], toolResults: [{ ok: true }] },
      { role: 'assistant' as const, text: 'The build  is green again\nafter the fix.', toolUses: [] },
      { role: 'user' as const, text: 'thanks', toolUses: [] },
      { role: 'assistant' as const, text: 'You are welcome, happy to help any time.', toolUses: [] },
    ]
    const finals = finalsFromHistory(rows)
    expect(finals).toEqual(['The build is green again after the fix.', 'You are welcome, happy to help any time.'])
    expect(isFinalBlock('The build is green again\n\nafter the fix.', finals)).toBe(true)
    expect(isFinalBlock('Now checking the build logs for you.', finals)).toBe(false)
  })

  test('the word prompt asks for no example and no literal fields', () => {
    expect(RULES).not.toContain('example_target')
    expect(RULES).not.toContain('"literal"')
  })
})

describe('CC-CEDICT check', () => {
  const dict = {
    rows: parseCedict('行\tháng\trow\txíng\tto walk\n电\tdiàn\telectric\n脑\tnǎo\tbrain\n电脑\tdiànnǎo\tcomputer'),
    hsk: parseHsk('电脑\t1\n行\t4\n'),
  }
  const word = (target: string, gloss: string) => ({
    en: 'x', occurrence: 1, target, romanization: '', pos: 'noun', gloss, literal: 'junk',
    exampleTarget: '', exampleRomanization: '', exampleEn: '', level: null, start: 0, end: 1,
  })

  test('a polyphone takes the reading whose meaning matches the gloss', () => {
    expect(verifyWord(word('行', 'walk'), dict).romanization).toBe('xíng')
    expect(verifyWord(word('行', 'row'), dict).romanization).toBe('háng')
  })

  test('pinyin, HSK and the breakdown come from the dictionary', () => {
    const w = verifyWord(word('电脑', 'computer'), dict)
    expect([w.romanization, w.level, w.verified, w.literal]).toEqual(['diànnǎo', 1, true, '电 electric + 脑 brain'])
  })

  test('a word the dictionary lacks is marked unverified', () => {
    expect(verifyWord(word('笔记', 'note'), dict).verified).toBe(false)
    expect(literalFor('电子', dict, 'kept')).toBe('kept')
  })
})

describe('usage, cap and the local request', () => {
  test('usage adds up per day and provider and formats in k', () => {
    let u = addUsage(EMPTY_USAGE, '2026-10-15', 'haiku', { input: 70_000, output: 25_000, cacheRead: 1000, cacheWrite: 0 })
    u = addUsage(u, '2026-10-14', 'haiku', { input: 300_000, output: 14_000, cacheRead: 0, cacheWrite: 0 })
    expect(u.days['2026-10-15']?.haiku?.calls).toBe(1)
    expect(usageLines(u, '2026-10-15')[0]).toBe('Today: 1 calls · 96k tokens (71k in / 25k out) · 7 days: 410k')
    const s = { ...DEFAULT_SETTINGS, cap: '100k' as const }
    expect(isCapReached(u, '2026-10-15', s)).toBe(false)
    expect(isCapReached(u, '2026-10-14', s)).toBe(true)
    expect(isCapReached(u, '2026-10-14', { ...s, model: 'local' })).toBe(false)
  })

  test('the local request is an OpenAI chat completion with a JSON schema array', () => {
    const r = localRequest({ endpoint: 'http://127.0.0.1:8080/v1/', localModel: '' }, 'RULES', 'PROMPT', { type: 'array' }, 100)
    expect(r.url).toBe('http://127.0.0.1:8080/v1/chat/completions')
    const body = JSON.parse(r.body)
    expect(body.messages.map((m: { role: string }) => m.role)).toEqual(['system', 'user'])
    expect(body.response_format.type).toBe('json_schema')
    expect(body.response_format.json_schema.schema.type).toBe('array')
    expect(parseLocalReply('{"choices":[{"message":{"content":"[]"}}],"usage":{"prompt_tokens":5,"completion_tokens":2}}')?.usage.input).toBe(5)
    expect(parseLocalReply('<html>')).toBe(null)
  })
})

import { isWeakSwap } from '../hooks/core'

describe('grammar guard', () => {
  const block = 'Run the test again now because the function expects an empty array and it failed.'
  const it = (en: string, target: string, pos: string) => ({ en, occurrence: 1, target, romanization: 'x', pos, gloss: en, level: 1 })

  test('function words and inflected verbs are dropped; nouns and base verbs survive', () => {
    const reply = JSON.stringify([
      it('again', '再', 'adverb'),
      it('now', '现在', 'adverb'),
      it('because', '因为', 'conjunction'),
      it('expects', '预期', 'verb'),
      it('failed', '失败', 'verb'),
      it('Run', '运行', 'verb'),
      it('test', '测试', 'noun'),
      it('function', '函数', 'noun'),
    ])
    const r = parseReply(reply, block, OPTS)
    expect(r.ok && r.words.map(w => w.target)).toEqual(['运行', '测试', '函数'])
  })

  test('a plural noun is kept; a third-person verb is not', () => {
    expect(isWeakSwap('tests', 'noun')).toBe(false)
    expect(isWeakSwap('runs', 'verb')).toBe(true)
    expect(isWeakSwap('pass', 'verb')).toBe(false)
    expect(isWeakSwap('The', 'noun')).toBe(true)
  })
})

describe('inflected verb check', () => {
  test('base verbs that look inflected survive; real inflections are dropped', () => {
    for (const en of ['need', 'proceed', 'embed', 'process', 'pass', 'focus', 'bring']) expect(isWeakSwap(en, 'verb')).toBe(false)
    for (const en of ['needed', 'processes', 'embeds', 'running', 'failed', 'expects']) expect(isWeakSwap(en, 'verb')).toBe(true)
  })
})

import { placeCard } from '../hooks/core'

describe('floating card placement', () => {
  const lines = ['电脑  diànnǎo', 'noun · computer', '电 electric + 脑 brain', 'HSK 1 · click for more']
  const spot = (row: number) => ({ row, x: 10, avail: 90, lineLeft: 2 })
  test('above when it fits on screen, below when only that fits, else the bar', () => {
    expect(placeCard(spot(7), lines, 20, undefined, 100)).toMatchObject({ kind: 'above', top: 1, left: 14 })
    expect(placeCard(spot(7), lines, 20, { first: 5, last: 30 }, 100)).toMatchObject({ kind: 'below', top: 8 })
    expect(placeCard(spot(7), lines, 10, { first: 5, last: 30 }, 100)).toEqual({ kind: 'bar' })
    expect(placeCard(spot(0), lines, 7, undefined, 100)).toMatchObject({ kind: 'below', top: 1 })
    expect(placeCard(spot(0), lines, 6, undefined, 100)).toEqual({ kind: 'bar' })
  })
  test('a short message whose top is on screen spills its card above it', () => {
    expect(placeCard(spot(1), lines, 2, { first: 0, last: 2 }, 100)).toMatchObject({ kind: 'above', top: -5 })
    expect(placeCard(spot(1), lines, 2, { first: 1, last: 2 }, 100)).toEqual({ kind: 'bar' })
    expect(placeCard(spot(1), lines, 2, null, 100)).toEqual({ kind: 'bar' })
  })
  test('on desktop, a card near the right edge moves left to fit', () => {
    const late = { row: 7, x: 110, avail: 120, lineLeft: 2 }
    expect(placeCard(late, lines, 20, undefined, 100, true)).toMatchObject({ kind: 'above', shift: -36 })
  })
})

import { planCards, placeSwaps } from '../hooks/core'

describe('desktop card planning', () => {
  const swap = (en: string, at: number) => ({
    en, occurrence: 1, target: '猫', romanization: 'māo', pos: 'noun', gloss: en, literal: '',
    exampleTarget: '', exampleRomanization: '', exampleEn: '', level: 1, start: at, end: at + en.length,
  })
  test('word buttons take room, so a line of swaps wraps sooner', () => {
    const text = 'cat '.repeat(30).trim()
    const words = Array.from({ length: 30 }, (_, i) => swap('cat', i * 4))
    const segs = planMessage(text, words)
    expect(placeSwaps(segs, words, 'hanzi', 125).spots.get(29)?.lineRow).toBe(0)
    expect(placeSwaps(segs, words, 'hanzi', 125, 2).spots.get(29)?.lineRow).toBe(1)
  })
  test('a late word that may start the next row gets its card there, above or below', () => {
    const late = `${'word '.repeat(22)}cat`
    const words = [swap('cat', 110)]
    const lower = [swap('cat', 752 + 110)]
    const above = planCards(planMessage(`${'word '.repeat(150)}\n\n${late}`, lower), lower, 'hanzi', 100, undefined, true).get(0)
    expect(above).toMatchObject({ kind: 'above', shift: 0 })
    const below = planCards(planMessage(late, words), words, 'hanzi', 100, undefined, true).get(0)
    expect(below).toMatchObject({ kind: 'below', top: 2, left: 2 })
  })
})

import { revertCopy } from '../hooks/copyback'

describe('copy as English', () => {
  const text = 'I opened the computer and read the file. Then I wrote a short note for you.'
  const w = (en: string, target: string, romanization: string) => ({
    en, occurrence: 1, target, romanization, pos: 'noun', gloss: en, literal: '',
    exampleTarget: '', exampleRomanization: '', exampleEn: '', level: 1,
    start: text.indexOf(en), end: text.indexOf(en) + en.length,
  })
  const blocks = [{ text, words: [w('computer', '电脑', 'diànnǎo'), w('note', '笔记', 'bǐjì')] }]

  test('a displayed selection maps back to English, wraps and gutter kept', () => {
    expect(revertCopy('\u23FA I opened the 电脑 and read\n  the file.', blocks, 'hanzi')).toBe('\u23FA I opened the computer and read\n  the file.')
  })
  test('a selection that starts or ends inside a swapped item gets the whole English word', () => {
    expect(revertCopy('脑 and read the', blocks, 'hanzi')).toBe('computer and read the')
    expect(revertCopy('a short 笔', blocks, 'hanzi')).toBe('a short note')
  })
  test('both mode with pinyin and pinyin mode map back', () => {
    expect(revertCopy('the 电脑 diànnǎo and read', blocks, 'both')).toBe('the computer and read')
    expect(revertCopy('opened the diànnǎo and', blocks, 'pinyin')).toBe('opened the computer and')
  })
  test('a mix with English maps back, the English in brackets included', () => {
    expect(revertCopy('the 电脑 diànnǎo (computer) and read', blocks, 'hanzi+pinyin+english')).toBe('the computer and read')
    expect(revertCopy('the 电脑 (computer) and', blocks, 'hanzi+english')).toBe('the computer and')
  })
  test('unrelated Chinese and non-matching text are left alone', () => {
    expect(revertCopy('我的电脑很快', blocks, 'hanzi')).toBe(null)
    expect(revertCopy('hello world', blocks, 'hanzi')).toBe(null)
    expect(revertCopy('I opened the', blocks, 'hanzi')).toBe(null)
  })
})

describe('draft sections are never translated', () => {
  test('a Slack draft label hides the paragraph after it; a later labelled paragraph is prose', () => {
    const t = 'Slack draft:\n\nHey team, the build is green and the release goes out today.\n\nWhat changed:\n\nThe build now runs the tests before it ships the release.'
    expect(splitBlocks(t).map(b => b.isProse)).toEqual([false, false, true, true])
    const reply = JSON.stringify([
      { en: 'team', occurrence: 1, target: '团队', romanization: 'tuánduì', pos: 'noun', gloss: 'team', level: 4 },
      { en: 'tests', occurrence: 1, target: '测试', romanization: 'cèshì', pos: 'noun', gloss: 'tests', level: 4 },
    ])
    const r = parseReply(reply, t, OPTS)
    expect(r.ok && r.words.map(x => x.en)).toEqual(['tests'])
  })
  test('a bold label or a heading that names an email or commit also counts', () => {
    expect(splitBlocks('**Email to the client**\n\nDear Anna, the report is ready.').map(b => b.isProse)).toEqual([false, false])
    expect(splitBlocks('## Commit message\n\nFix the parser for empty input.').map(b => b.isProse)).toEqual([false, false])
  })
})

describe('clause-initial linking words', () => {
  const pick = (text: string, en: string, target: string, pos: string) =>
    parseReply(JSON.stringify([{ en, occurrence: 1, target, romanization: 'x', pos, gloss: en, level: 1 }]), text, OPTS)
  test('a linking word that opens a clause is kept; inside a clause it is dropped', () => {
    expect(pick('Because the input is empty, the test fails today.', 'Because', '因为', 'conjunction')).toMatchObject({ ok: true, words: [{ target: '因为' }] })
    expect(pick('The test fails because the function returns nothing.', 'because', '因为', 'conjunction')).toMatchObject({ ok: true, words: [] })
    expect(pick('Basically, it swaps nouns for Chinese while you read.', 'Basically', '基本上', 'adverb')).toMatchObject({ ok: true, words: [{ target: '基本上' }] })
    expect(pick('If it breaks, run it again and check the logs here.', 'again', '再', 'adverb')).toMatchObject({ ok: true, words: [] })
    expect(pick('- Then run the tests and read the log output.', 'Then', '然后', 'adverb')).toMatchObject({ ok: true, words: [{ target: '然后' }] })
  })
})

import { dayOf, extractJson, parseUtcOffset, setDayOffset } from '../hooks/core'

describe('robustness', () => {
  test('day keys use the local date', () => {
    const ms = Date.parse('2026-10-16T05:03:00Z')
    expect(parseUtcOffset('-0700')).toBe(-420)
    setDayOffset(-420)
    expect(dayOf(ms)).toBe('2026-10-15')
    setDayOffset(0)
    expect(dayOf(ms)).toBe('2026-10-16')
  })
  test('a reply cut off by the token cap keeps its complete items', () => {
    const cut = '[{"en":"test","occurrence":1,"target":"测试"},{"en":"note","occurrence":1,"tar'
    expect(extractJson(cut)).toEqual([{ en: 'test', occurrence: 1, target: '测试' }])
  })
})

import { phraseCap, keyFor as keyFor2 } from '../hooks/core'
import { segment } from '../hooks/dict'

describe('phrases and coverage', () => {
  const text = 'If it breaks, run the test again and check the logs for the error.'
  const phrase = { kind: 'phrase', en: 'run the test again', occurrence: 1, target: '再运行测试', romanization: 'zai yunxing ceshi', pos: 'phrase', gloss: 'run the test again', level: 1 }
  const again = { kind: 'word', en: 'again', occurrence: 1, target: '再', romanization: 'zài', pos: 'adverb', gloss: 'again', level: 1 }

  test('phrase limits follow level and coverage', () => {
    expect([phraseCap('beginner', 'natural'), phraseCap('intermediate', 'natural'), phraseCap('advanced', 'natural'), phraseCap('beginner', 'maximum')]).toEqual([0, 1, 2, 1])
  })

  test('a phrase is kept at intermediate and dropped at beginner (natural)', () => {
    const kept = parseReply(JSON.stringify([phrase]), text, { ...OPTS, maxPhrases: 1 })
    expect(kept.ok && kept.words.map(w => [w.target, w.kind, text.slice(w.start, w.end)])).toEqual([['再运行测试', 'phrase', 'run the test again']])
    const dropped = parseReply(JSON.stringify([phrase]), text, { ...OPTS, maxPhrases: 0 })
    expect(dropped.ok && dropped.words).toEqual([])
  })

  test('maximum keeps an adverb that natural drops', () => {
    expect(parseReply(JSON.stringify([again]), text, { ...OPTS, coverage: 'natural' })).toMatchObject({ ok: true, words: [] })
    expect(parseReply(JSON.stringify([again]), text, { ...OPTS, coverage: 'maximum' })).toMatchObject({ ok: true, words: [{ target: '再' }] })
  })

  test('the dictionary segments a phrase and builds its pinyin, breakdown and level', () => {
    const d = {
      rows: parseCedict('再\tzài\tagain\n运行\tyùnxíng\tto run\n测试\tcèshì\tto test\n运\tyùn\tto move\n行\tháng\trow\txíng\tto walk'),
      hsk: parseHsk('再\t2\n运行\t5\n测试\t5\n'),
    }
    expect(segment('再运行测试', d)).toEqual(['再', '运行', '测试'])
    const w = verifyWord({ ...phrase, kind: 'phrase', literal: '', exampleTarget: '', exampleRomanization: '', exampleEn: '', start: 0, end: 1 } as never, d)
    expect([w.romanization, w.literal, w.level, w.verified]).toEqual(['zài yùnxíng cèshì', '再 again + 运行 run + 测试 test', 5, true])
  })

  test('copy reverts a whole phrase to its English span', () => {
    const r = parseReply(JSON.stringify([phrase]), text, { ...OPTS, maxPhrases: 1 })
    if (!r.ok) throw new Error('parse')
    const words = r.words.map(w => ({ ...w, romanization: 'zài yùnxíng cèshì' }))
    expect(revertCopy('If it breaks, 再运行测试 and check', [{ text, words }], 'hanzi')).toBe('If it breaks, run the test again and check')
    expect(revertCopy('breaks, 再运行测试 zài yùnxíng cèshì and', [{ text, words }], 'both')).toBe('breaks, run the test again and')
  })

  test('the cache key differs by coverage', () => {
    expect(keyFor2(text, DEFAULT_SETTINGS)).not.toBe(keyFor2(text, { ...DEFAULT_SETTINGS, coverage: 'maximum' }))
  })
})

describe('compact reply format', () => {
  test('one item per line; malformed lines are dropped; empty means none', () => {
    const text = 'I opened the computer and read the file. Then I wrote a short note for you.'
    const r = parseReply('word|computer|1|电脑|noun|computer\nbad line\nword|note|1|笔记|noun|a short written note here too\n', text, OPTS)
    expect(r.ok && r.words.map(w => [w.target, w.gloss])).toEqual([['电脑', 'computer'], ['笔记', 'a short written note here']])
    expect(parseReply('', text, OPTS)).toEqual({ ok: true, words: [] })
    expect(parseReply('I could not find any good words to pick in this block.', text, OPTS).ok).toBe(false)
  })
})

describe('spreading picks across paragraphs', () => {
  const nouns = [
    ['server', 'client', 'cache', 'queue', 'log'],
    ['window', 'button', 'screen', 'menu', 'panel'],
    ['table', 'column', 'index', 'record', 'field'],
    ['branch', 'commit', 'merge', 'tag', 'remote'],
    ['token', 'model', 'prompt', 'reply', 'limit'],
  ]
  const paras = nouns.map(n => `This part covers the ${n[0]}, the ${n[1]}, the ${n[2]}, the ${n[3]} and the ${n[4]} for this week.`)
  const text = paras.join('\n\n')
  const line = (en: string) => `word|${en}|1|词|noun|${en}`
  const inPara = (r: ReturnType<typeof parseReply>, i: number) =>
    r.ok ? r.words.filter(w => w.start >= text.indexOf(paras[i]!) && w.end <= text.indexOf(paras[i]!) + paras[i]!.length).length : -1

  test('picks bunched in the first paragraphs are thinned to a fair share each', () => {
    const r = parseReply([...nouns[0]!, ...nouns[1]!].map(line).join('\n'), text, { ...OPTS, cap: 12 })
    expect([inPara(r, 0), inPara(r, 1)]).toEqual([4, 4])
  })

  test('picks that already reach the last paragraph are left alone', () => {
    const r = parseReply([...nouns[0]!, ...nouns[4]!.slice(0, 2)].map(line).join('\n'), text, { ...OPTS, cap: 12 })
    expect(r.ok && r.words.length).toBe(7)
  })
})

describe('the item cap scales with length', () => {
  test('a 40-sentence block at normal caps at 30; a 6-sentence block at 6', () => {
    const block = (n: number) => Array.from({ length: n }, (_, i) => `Sentence number ${i + 1} is here.`).join(' ')
    expect(swapCap(block(40), 'normal')).toBe(30)
    expect(swapCap(block(6), 'normal')).toBe(6)
    expect(swapCap(block(6), 'low')).toBe(2)
  })
})

import { chunkBlock } from '../hooks/core'

describe('chunking a long block', () => {
  test('paragraphs group into chunks of about 7 sentences; a long paragraph splits at sentence ends', () => {
    const para = (n: number, tag: string) => Array.from({ length: n }, (_, i) => `${tag} sentence ${i + 1} ends here.`).join(' ')
    const text = [para(3, 'A'), para(4, 'B'), para(5, 'C'), para(14, 'D')].join('\n\n')
    const chunks = chunkBlock(text)
    expect(chunks.map(c => c.sentences)).toEqual([7, 5, 7, 7])
    expect(text.slice(chunks[0]!.start, chunks[0]!.end).startsWith('A sentence 1')).toBe(true)
    expect(text.slice(chunks[1]!.start, chunks[1]!.end)).toBe(para(5, 'C'))
    expect(text.slice(chunks[3]!.start, chunks[3]!.end).trim().endsWith('D sentence 14 ends here.')).toBe(true)
  })
})

import { mdRows } from '../hooks/core'

describe('markdown row estimate', () => {
  test('code fences and emphasis marks take no rows or cells', () => {
    expect(mdRows('**Fix:** type this:\n\n```\n/tui fullscreen\n```', 80)).toBe(3)
    expect(mdRows(`**${'a'.repeat(10)}**`, 10)).toBe(1)
  })
  test('a table draws a border line above and a rule under each row', () => {
    expect(mdRows('| a | b |\n|---|---|\n| 1 | 2 |\n| 3 | 4 |\n\nafter', 80)).toBe(9)
  })
})

import { cardRows, wrapCells } from '../hooks/core'

describe('card wrapping', () => {
  test('long lines wrap at spaces with an indent instead of being cut', () => {
    expect(wrapCells('最近的终端更新  zuìjìn de zhōngduān gēngxīn', 35)).toEqual(['最近的终端更新  zuìjìn de zhōngduān', '  gēngxīn'])
    expect(wrapCells('short', 10)).toEqual(['short'])
    expect(wrapCells('aaaaaaaaaaaaaaa', 10)).toEqual(['aaaaaaaaa\u2026'])
    const rows = cardRows(['最近的终端更新  zuìjìn de zhōngduān gēngxīn', 'phrase · recent terminal update'], 36)
    expect(rows.map(r => r.line)).toEqual([0, 0, 1])
  })
})

import { ankiNotes, audioName, exportWords, toneSpans, ttsClips, EMPTY_PROGRESS } from '../hooks/core'
import type { OsmosisWord } from '../types'

const saved = (target: string, romanization: string, gloss: string): OsmosisWord => ({
  en: gloss, occurrence: 1, target, romanization, pos: 'noun', gloss, literal: '',
  exampleTarget: '', exampleRomanization: '', exampleEn: '', level: 1, start: 0, end: 0,
})

describe('anki export', () => {
  test('pinyin syllables get one span per tone, with or without spaces', () => {
    expect(toneSpans('diànnǎo')).toBe('<span class="t4">diàn</span><span class="t3">nǎo</span>')
    expect(toneSpans('xīngān')).toBe('<span class="t1">xīn</span><span class="t1">gān</span>')
    expect(toneSpans('Nǐ hǎo ma?')).toBe('<span class="t3">Nǐ</span> <span class="t3">hǎo</span> <span class="t5">ma</span>?')
  })

  test('pinyin that will not split stays plain and escaped', () => {
    expect(toneSpans('<b>ok</b>')).toBe('&lt;b&gt;ok&lt;/b&gt;')
  })

  test('only words not yet exported are picked, unless all are asked for', () => {
    const progress = { ...EMPTY_PROGRESS, saved: { 窗口: saved('窗口', 'chuāngkǒu', 'window'), 表格: saved('表格', 'biǎogé', 'table') }, exported: { 窗口: '2026-01-01' } }
    expect(exportWords(progress, false).map(w => w.target)).toEqual(['表格'])
    expect(exportWords(progress, true).map(w => w.target)).toEqual(['窗口', '表格'])
  })

  test('words in other languages are not exported', () => {
    const progress = { ...EMPTY_PROGRESS, saved: { ventana: saved('ventana', '', 'window'), 表格: saved('表格', 'biǎogé', 'table') } }
    expect(exportWords(progress, true).map(w => w.target)).toEqual(['表格'])
  })

  test('notes carry the card fields only, HTML-escaped', () => {
    const w = { ...saved('表格', 'biǎogé', 'table <grid>'), exampleTarget: '这个表格很长。', exampleEn: 'This table is long.' }
    expect(ankiNotes([w])).toEqual([{
      hanzi: '表格',
      pinyin: '<span class="t3">biǎo</span><span class="t2">gé</span>',
      meaning: 'table &lt;grid&gt;',
      example: '这个表格很长。',
      exampleEn: 'This table is long.',
      audio: audioName('表格'),
      exampleAudio: audioName('这个表格很长。'),
    }])
  })

  test('audio files are named by their text, and each text is voiced once', () => {
    expect(audioName('表格')).toMatch(/^osmosis-[0-9a-f]{16}\.mp3$/)
    expect(audioName('表格')).toBe(audioName('表格'))
    expect(audioName('')).toBe('')
    const words = [{ ...saved('表格', 'biǎogé', 'table'), exampleTarget: '表格很长。' }, saved('表格', 'biǎogé', 'table')]
    expect(ttsClips(words)).toEqual([{ text: '表格', name: audioName('表格') }, { text: '表格很长。', name: audioName('表格很长。') }])
  })
})

import { showLabel, showParts, shownFull, showValue, toggleShow } from '../hooks/core'

describe('show: any mix of hanzi, pinyin and English', () => {
  const w = { en: 'computer', occurrence: 1, target: '电脑', romanization: 'diànnǎo', pos: 'noun', gloss: 'computer', literal: '', exampleTarget: '', exampleRomanization: '', exampleEn: '', level: 1, start: 0, end: 8 }
  test('old values keep their meaning, and hanzi or pinyin is always on', () => {
    expect([...showParts('both')]).toEqual(['hanzi', 'pinyin'])
    expect([...showParts('pinyin')]).toEqual(['pinyin'])
    expect([...showParts('english')]).toEqual(['english', 'hanzi'])
    expect(showValue(showParts('english+pinyin'))).toBe('pinyin+english')
  })
  test('a toggle turns one part on or off but never leaves English alone', () => {
    expect(toggleShow('hanzi', 'english')).toBe('hanzi+english')
    expect(toggleShow('hanzi+english', 'english')).toBe('hanzi')
    expect(toggleShow('hanzi+english', 'hanzi')).toBe('hanzi+english')
    expect(toggleShow('both', 'hanzi')).toBe('pinyin')
  })
  test('the word shows its parts in order, the English in brackets', () => {
    expect(shownFull(w, 'hanzi')).toBe('电脑')
    expect(shownFull(w, 'both')).toBe('电脑 diànnǎo')
    expect(shownFull(w, 'pinyin+english')).toBe('diànnǎo (computer)')
    expect(shownFull(w, 'hanzi+pinyin+english')).toBe('电脑 diànnǎo (computer)')
    expect(showLabel('hanzi+pinyin+english')).toBe('Hanzi + Pinyin + English')
  })
})

import { promptPaneKey } from '../hooks/core'

describe('pane keys typed into the prompt', () => {
  test('one pane key into an empty prompt is the pane key; anything else is typing', () => {
    expect(promptPaneKey('', 's')).toBe('s')
    expect(promptPaneKey('', 'x')).toBe('x')
    expect(promptPaneKey('', 'S')).toBe(null)
    expect(promptPaneKey('', 'a')).toBe(null)
    expect(promptPaneKey('', 'so')).toBe(null)
    expect(promptPaneKey('hi', 's')).toBe(null)
  })
})
