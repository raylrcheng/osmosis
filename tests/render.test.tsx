import type { On } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'

import { DEFAULT_SETTINGS, keyFor } from '../hooks/core'

const TEXT =
  'I opened the computer and read the file. Then I wrote a short note for you and pushed it.\n\n```ts\nconst computer = 1 // the computer value that the build step reads in this small test\nconst flag = "a short flag"\n```'

const REPLY = 'word|computer|1|电脑|noun|computer'

const USAGE = { input_tokens: 1000, output_tokens: 500, cache_read_input_tokens: 200, cache_creation_input_tokens: 0 }
const MESSAGE = { component: 'AssistantMessage', props: { text: TEXT, isFirstOfReply: true } } as const
const SCROLL = { offset: 0, bodyRows: 3 }

type Node = { type?: string; key?: string; props?: Record<string, unknown>; hover?: Record<string, unknown>; children?: unknown[] }

function walk(tree: unknown, pick: (n: Node) => boolean): Node[] {
  const out: Node[] = []
  const visit = (n: unknown) => {
    if (typeof n !== 'object' || n === null) return
    const node = n as Node
    if (pick(node)) out.push(node)
    for (const c of node.children ?? []) visit(c)
  }
  visit(tree)
  return out
}

const hoverOf = (tree: unknown, key: string) => walk(tree, n => n.props?.key === key)[0]?.hover as { scope?: string } | undefined
const LOW_TEXT =
  [1, 2, 3, 4, 5, 6, 7].map(n => `- Item number ${n} is a plain line.`).join('\n') + '\n- I opened the computer and read the file.'

const DICT: Record<string, string> = {
  'sources.json': JSON.stringify({ files: ['cedict-0.tsv'], hsk: 'hsk.tsv' }),
  'cedict-0.tsv': [
    '电\tdiàn\telectric',
    '脑\tnǎo\tbrain',
    '电脑\tdiànnǎo\tcomputer',
    '服务器\tfúwùqì\tserver',
    '窗口\tchuāngkǒu\twindow',
    '表格\tbiǎogé\ttable',
    '笔记\tbǐjì\tnotes',
    '构\tgòu\tto construct',
    '建\tjiàn\tto establish',
    '构建\tgòujiàn\tto construct (sth abstract)',
    '行\tháng\trow\txíng\tto walk',
    '再\tzài\tagain',
    '运行\tyùnxíng\tto run',
    '测试\tcèshì\tto test',
  ].join('\n'),
  'hsk.tsv': '电脑\t1\n行\t4\n',
}

const EXAMPLE_REPLY = JSON.stringify({ example_target: '电脑坏了。', example_romanization: 'Diànnǎo huài le.', example_en: 'The computer broke.' })

type FetchAnswer = { status: number; text: string } | 'throw'
type RunAnswer = { exitCode?: number; stdout?: string; stderr?: string }
type WorldOptions = { history?: string[]; fetch?: (url: string, body: string) => FetchAnswer; run?: (argv: readonly string[]) => RunAnswer | undefined }

type Reply = string | null | ((prompt: string) => string | null | Promise<string | null>)

function world(on: On, reply: Reply, store: Record<string, unknown> = {}, opts: WorldOptions = {}) {
  const clock = mock.clock(on, { now: 1_760_000_000_000 })
  mock.store(on, store)
  const calls = { model: 0, example: 0, opened: [] as string[], fetched: [] as { url: string; body: string }[], status: [] as (string | undefined)[], runs: [] as { argv: readonly string[]; stdin: string }[] }
  const history = opts.history ?? [TEXT, LOW_TEXT]
  const clip = { value: '', writes: [] as string[], reads: 0 }
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('session.messages', () => ({
    value: history.flatMap(text => [
      { role: 'user' as const, text: 'please', toolUses: [] },
      { role: 'assistant' as const, text, toolUses: [] },
    ]),
  }))
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  on('process.run', ($, e) => {
    const out = (stdout: string) => ({ value: { exitCode: 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } })
    if (e.argv[0] === 'pbpaste') {
      clip.reads++
      return out(clip.value)
    }
    if (e.argv[0] === 'pbcopy') {
      clip.writes.push(String(e.init?.stdin ?? ''))
      clip.value = String(e.init?.stdin ?? '')
      return out('')
    }
    const answer = opts.run?.(e.argv)
    if (answer) {
      calls.runs.push({ argv: e.argv, stdin: String(e.init?.stdin ?? '') })
      return { value: { exitCode: answer.exitCode ?? 0, stdout: answer.stdout ?? '', stderr: answer.stderr ?? '', isStdoutTruncated: false, isStderrTruncated: false } }
    }
    return out('Tingting            zh_CN    # 你好\n')
  })
  on('ui.status', ($, e) => {
    calls.status.push(e.text)
    return { value: undefined }
  })
  on('ui.log', () => ({ value: undefined }))
  on('fs.read', ($, e) => {
    const name = String(e.path).split('/').pop() ?? ''
    const text = DICT[name]
    return text === undefined ? { deny: `no ${name}` } : { value: text }
  })
  on('http.fetch', ($, e) => {
    const body = String(e.init?.body ?? '')
    calls.fetched.push({ url: e.url, body })
    const answer = opts.fetch ? opts.fetch(e.url, body) : 'throw'
    if (answer === 'throw') return { deny: 'connection refused' }
    return { value: { status: answer.status, ok: answer.status < 300, headers: {}, text: answer.text } }
  })
  on('ui.open', ($, e) => {
    calls.opened.push(e.id)
    return { value: { isPlaced: true as const } }
  })
  on('model.complete', async ($, e) => {
    if (e.prompt.includes('EXAMPLE REQUEST')) {
      calls.example++
      return { value: { isAnswered: true as const, text: EXAMPLE_REPLY, usage: USAGE } }
    }
    calls.model++
    const text = typeof reply === 'function' ? await reply(e.prompt) : reply
    return text === null
      ? { value: { isAnswered: false as const, reason: 'empty-reply' as const, usage: USAGE } }
      : { value: { isAnswered: true as const, text, usage: USAGE } }
  })
  on('ui.render', { component: 'AssistantMessage' }, ($, e) => {
    const { Text } = $.ui.resolve(e)
    return <Text>ENGINE</Text>
  })
  on('ui.render', { component: 'AbovePrompt' }, ($, e) => {
    const { Text } = $.ui.resolve(e)
    return <Text>ENGINE-BAND</Text>
  })
  return { clock, calls, clip }
}

test('the reply draws as the engine draws it while no translation exists', async ($, on) => {
  world(on, REPLY)
  await $.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true })
  const ui = await $.ui.mount({ plugin: 'osmosis', surface: 'terminal', ...MESSAGE })
  expect(await ui.find({ text: 'ENGINE' })).toBeDefined()
  expect(await ui.find({ type: 'Button' })).toBeUndefined()
})

test('a session another Claude session started stays in English', async ($, on) => {
  mock.env(on, { CLAUDE_CODE_CHILD_SESSION: '1' })
  const { clock, calls } = world(on, REPLY)
  await $.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true })
  const ui = await $.ui.mount({ plugin: 'osmosis', surface: 'terminal', ...MESSAGE })
  await settleAll(clock)
  expect(await ui.find({ text: 'ENGINE' })).toBeDefined()
  expect(await ui.find({ type: 'Button' })).toBeUndefined()
  const band = await $.ui.mount(BAND)
  expect(await band.find({ text: 'ENGINE-BAND' })).toBeDefined()
  expect(calls.model).toBe(0)
  expect(calls.status).toEqual([])
})

test('a subagent reply stays in English; the same reply from the main loop is translated', async ($, on) => {
  on('turn.complete', ($, e) => ({ text: e.answer }))
  const { clock, calls } = world(on, REPLY, {}, { history: [] })
  await $.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true })
  const ui = await $.ui.mount({ plugin: 'osmosis', surface: 'terminal', ...MESSAGE })
  await $.turn.complete({ answer: TEXT, durationMs: 10, isAborted: false, turnId: 't1', agentId: 'a1', reason: 'answer' })
  await settleAll(clock)
  expect(calls.model).toBe(0)
  expect(await ui.find({ text: 'ENGINE' })).toBeDefined()
  await $.turn.complete({ answer: TEXT, durationMs: 10, isAborted: false, turnId: 't2', reason: 'answer' })
  await settleAll(clock)
  expect(calls.model).toBe(1)
  expect(await ui.find({ key: 'w-0' })).toBeDefined()
})

test('a translation in state draws a hover-scoped word button, on terminal and desktop', async ($, on) => {
  const { clock, calls } = world(on, REPLY)
  await $.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true })
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ plugin: 'osmosis', surface, ...MESSAGE })
    await clock.advance(2000)
    await clock.settle()
    const word = await ui.find({ key: 'w-0' })
    expect(word?.type).toBe('Button')
    expect(word?.text).toContain('电脑')
    expect(hoverOf(await ui.drawn(), 'w-0')?.scope).toMatch(/^tw-[0-9a-f]{16}-0$/)
    expect(await ui.find({ text: 'ENGINE' })).toBeUndefined()
    expect(await ui.find({ type: 'Markdown', text: 'const computer' })).toBeDefined()
    await ui.unmount()
  }
  expect(calls.model).toBe(1)
})

const BAND = {
  plugin: 'osmosis',
  surface: 'terminal',
  component: 'AbovePrompt',
  props: { hasSurvey: false, isWorking: false, maxRows: 6, bodyColumns: 100, scroll: SCROLL, view: {} },
} as const

test('a translated reply keeps markdown links and bare URLs clickable', async ($, on) => {
  const text = TEXT.replace('read the file', 'read [the file](https://example.com/report)').replace('pushed it.', 'pushed it to https://example.com/raw now.')
  const { clock } = world(on, REPLY, {}, { history: [text] })
  await $.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true })
  const ui = await $.ui.mount({ plugin: 'osmosis', surface: 'terminal', component: 'AssistantMessage', props: { text, isFirstOfReply: true } })
  await clock.advance(2000)
  await clock.settle()
  expect((await ui.find({ key: 'w-0' }))?.text).toContain('电脑')
  const links = walk(await ui.drawn(), n => n.type === 'Link').map(n => n.props?.href)
  expect([...new Set(links)]).toEqual(['https://example.com/report', 'https://example.com/raw'])
})

test('the band holds a hidden card under the same hover scope', async ($, on) => {
  const { clock } = world(on, REPLY)
  await $.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true })
  await $.command.run({ command: 'osmosis', args: 'card both', origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 120 } })
  const msg = await $.ui.mount({ plugin: 'osmosis', surface: 'terminal', ...MESSAGE })
  await clock.advance(2000)
  await clock.settle()
  const scope = hoverOf(await msg.drawn(), 'w-0')?.scope
  expect(scope).toBeDefined()
  const band = await $.ui.mount({
    plugin: 'osmosis',
    surface: 'terminal',
    component: 'AbovePrompt',
    props: { hasSurvey: false, isWorking: false, maxRows: 6, bodyColumns: 100, scroll: SCROLL, view: {} },
  })
  const card = walk(await band.drawn(), n => n.type === 'Box' && n.hover?.scope === scope)[0]
  expect(card?.props?.display).toBe('none')
  expect(card?.hover?.display).toBe('flex')
  expect(JSON.stringify(card)).toContain('电 electric + 脑 brain')
  expect(await band.find({ text: /Osmosis 中文 · beginner · 1 words today/ })).toBeDefined()
})

test('clicking a word opens the pane on that word', async ($, on) => {
  const { clock, calls } = world(on, REPLY)
  await $.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true })
  const msg = await $.ui.mount({ plugin: 'osmosis', surface: 'terminal', ...MESSAGE })
  await clock.advance(2000)
  await clock.settle()
  await msg.press({ key: 'w-0' })
  expect(calls.opened).toContain('osmosis')
  const pane = await $.ui.mount({
    plugin: 'osmosis',
    surface: 'terminal',
    component: 'Pane',
    requestId: 'osmosis',
    props: { title: 'Osmosis 中文', isFocused: false, bodyColumns: 60, placement: 'dock', scroll: SCROLL, view: {} },
  })
  await settleAll(clock)
  expect(await pane.find({ text: 'The computer broke.' })).toBeDefined()
  expect(await pane.find({ key: 'speak' })).toBeDefined()
  await pane.press({ key: 'save' })
  expect((await pane.find({ key: 'save' }))?.text).toContain('Unsave')
})

test('a failed model call leaves the reply as the engine draws it', async ($, on) => {
  const { clock, calls } = world(on, null)
  await $.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true })
  const ui = await $.ui.mount({ plugin: 'osmosis', surface: 'terminal', ...MESSAGE })
  await clock.advance(4000)
  await clock.settle()
  expect(calls.model).toBe(2)
  expect(await ui.find({ text: 'ENGINE' })).toBeDefined()
})

test('/osmosis off turns every hook back to the engine', async ($, on) => {
  world(on, REPLY)
  await $.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true })
  const r = await $.command.run({
    command: 'osmosis',
    args: 'off',
    origin: { kind: 'composer' },
    presentation: { isFullscreen: true, columns: 120 },
  })
  expect(r.text).toBe('Osmosis: Off. Turn all translation on or off.')
  const band = await $.ui.mount({
    plugin: 'osmosis',
    surface: 'terminal',
    component: 'AbovePrompt',
    props: { hasSurvey: false, isWorking: false, maxRows: 6, bodyColumns: 100, scroll: SCROLL, view: {} },
  })
  expect(await band.find({ text: 'ENGINE-BAND' })).toBeDefined()
})

const savedWord = (target: string, gloss: string) => ({
  en: gloss, occurrence: 1, target, romanization: '', pos: 'noun', gloss, literal: '',
  exampleTarget: '', exampleRomanization: '', exampleEn: '', level: 1, start: 0, end: 1,
})

test('the quiz asks from saved words and a right answer adds mastery', async ($, on) => {
  const saved = Object.fromEntries(
    [['电脑', 'computer'], ['笔记', 'note'], ['文件', 'file'], ['朋友', 'friend']].map(([t, g]) => [t!, savedWord(t!, g!)]),
  )
  world(on, REPLY, { progress: { seen: {}, known: {}, saved, mastery: {}, today: { date: '', count: 0 } } })
  await $.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true })
  await $.command.run({ command: 'osmosis', args: 'quiz', origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 120 } })
  const pane = await $.ui.mount({
    plugin: 'osmosis',
    surface: 'terminal',
    component: 'Pane',
    requestId: 'osmosis',
    props: { title: 'Osmosis 中文', isFocused: true, bodyColumns: 60, placement: 'dock', scroll: SCROLL, view: {} },
  })
  const asked = (await pane.find({ type: 'Text', text: /^"/ }))?.text.replace(/"/g, '')
  const target = Object.values(saved).find(w => w.gloss === asked)?.target
  const choices = await pane.findAll({ type: 'Button', text: /^[\u4e00-\u9fff]+$/ })
  expect(choices).toHaveLength(4)
  const right = choices.find(c => c.text === target)
  await pane.press({ key: right!.key! })
  expect(await pane.find({ text: /^Right:/ })).toBeDefined()
  expect(await pane.find({ text: 'Question 2 of 4 · score 1' })).toBeDefined()
})

const PANE = {
  plugin: 'osmosis',
  surface: 'terminal',
  component: 'Pane',
  requestId: 'osmosis',
  props: { title: 'Osmosis 中文', isFocused: true, bodyColumns: 80, placement: 'dock', scroll: SCROLL, view: {} },
} as const

test('a press on a level button in the pane changes the setting', async ($, on) => {
  world(on, REPLY)
  await $.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true })
  const pane = await $.ui.mount(PANE)
  expect((await pane.find({ key: 'level-beginner' }))?.props.variant).toBe('primary')
  await pane.press({ key: 'level-advanced' })
  expect((await pane.find({ key: 'level-advanced' }))?.props.variant).toBe('primary')
  expect((await pane.find({ key: 'level-beginner' }))?.props.variant).toBe('secondary')
  const band = await $.ui.mount({
    plugin: 'osmosis',
    surface: 'terminal',
    component: 'AbovePrompt',
    props: { hasSurvey: false, isWorking: false, maxRows: 6, bodyColumns: 100, scroll: SCROLL, view: {} },
  })
  expect(await band.find({ text: /Osmosis 中文 · advanced/ })).toBeDefined()
})

test('the on/off toggle in the pane turns the reply hook back to the engine', async ($, on) => {
  const { clock } = world(on, REPLY)
  await $.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true })
  const msg = await $.ui.mount({ plugin: 'osmosis', surface: 'terminal', ...MESSAGE })
  await clock.advance(2000)
  await clock.settle()
  expect(await msg.find({ key: 'w-0' })).toBeDefined()
  const pane = await $.ui.mount(PANE)
  expect((await pane.find({ key: 'set-off' }))?.props.hotkey).toBe('o')
  await pane.press({ key: 'set-off' })
  expect((await pane.find({ key: 'set-off' }))?.props.variant).toBe('primary')
  await msg.redraw()
  expect(await msg.find({ text: 'ENGINE' })).toBeDefined()
  expect(await msg.find({ key: 'w-0' })).toBeUndefined()
})

test('with the hover card in the bar, the word draws no floating card', async ($, on) => {
  const { clock } = world(on, REPLY)
  await $.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true })
  const r = await $.command.run({ command: 'osmosis', args: 'card bar', origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 120 } })
  expect(r.text).toBe('Osmosis hover card: In the bar. Where the word card appears when you point at a word.')
  const msg = await $.ui.mount({ plugin: 'osmosis', surface: 'terminal', ...MESSAGE })
  await clock.advance(2000)
  await clock.settle()
  const tree = await msg.drawn()
  expect(walk(tree, n => n.props?.key === 'w-0')).toHaveLength(1)
  expect(walk(tree, n => n.props?.position === 'absolute')).toHaveLength(0)
})

const BUILD_TEXT = 'The build is green now. I fixed the failing check and pushed the change for you.\n\nNothing else changed in this round, and the release can go out later today after one more look at the logs and the dashboard.'
const PANE_PROPS = {
  plugin: 'osmosis',
  surface: 'terminal',
  component: 'Pane',
  requestId: 'osmosis',
  props: { title: 'Osmosis 中文', isFocused: true, bodyColumns: 90, placement: 'dock', scroll: SCROLL, view: {} },
} as const
const BAND_PROPS = {
  plugin: 'osmosis',
  surface: 'terminal',
  component: 'AbovePrompt',
  props: { hasSurvey: false, isWorking: false, maxRows: 6, bodyColumns: 120, scroll: SCROLL, view: {} },
} as const
const item = (en: string, target: string, romanization: string, level: number | null, extra: Record<string, unknown> = {}) => ({
  en, occurrence: 1, target, romanization, pos: 'noun', gloss: en, level, ...extra,
})

async function settleAll(clock: { advance: (ms: number) => Promise<void>; settle: () => Promise<void> }) {
  for (let i = 0; i < 3; i++) {
    await clock.advance(1500)
    await clock.settle()
  }
}

async function paneText(ui: { drawn: () => Promise<unknown> }) {
  const texts: string[] = []
  const visit = (n: unknown) => {
    if (typeof n === 'string') texts.push(n)
    else if (n && typeof n === 'object') {
      if ((n as Node).type === 'Markdown') texts.push(String((n as Node).props?.text ?? ''))
      for (const c of (n as Node).children ?? []) visit(c)
    }
  }
  visit(await ui.drawn())
  return texts.join('')
}

test('only the final block of a reply is translated; a mid-turn block costs nothing', async ($, on) => {
  on('turn.complete', ($, e) => ({ text: e.answer }))
  const { clock, calls } = world(on, REPLY, {}, { history: [] })
  await $.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true })
  const mid = await $.ui.mount({ plugin: 'osmosis', surface: 'terminal', component: 'AssistantMessage', props: { text: 'Now checking the computer logs to see what went wrong there.', isFirstOfReply: true } })
  const last = await $.ui.mount({ plugin: 'osmosis', surface: 'terminal', ...MESSAGE })
  await settleAll(clock)
  expect(calls.model).toBe(0)
  await $.turn.complete({ answer: TEXT, durationMs: 10, isAborted: false, turnId: 't1', reason: 'answer' })
  await settleAll(clock)
  expect(calls.model).toBe(1)
  expect(await last.find({ key: 'w-0' })).toBeDefined()
  expect(await mid.find({ text: 'ENGINE' })).toBeDefined()
})

test('the example sentence loads lazily when the pane opens a word', async ($, on) => {
  const { clock, calls } = world(on, JSON.stringify([item('computer', '电脑', 'diànnǎo', 1)]))
  await $.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true })
  const msg = await $.ui.mount({ plugin: 'osmosis', surface: 'terminal', ...MESSAGE })
  await settleAll(clock)
  expect(calls.example).toBe(0)
  await msg.press({ key: 'w-0' })
  const pane = await $.ui.mount(PANE_PROPS)
  expect(await pane.find({ text: 'loading example...' })).toBeDefined()
  await settleAll(clock)
  expect(calls.example).toBe(1)
  expect(await pane.find({ text: '电脑坏了。' })).toBeDefined()
  expect(await pane.find({ text: 'The computer broke.' })).toBeDefined()
})

test('the counter adds each call usage and the pane shows it', async ($, on) => {
  const { clock } = world(on, REPLY)
  await $.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true })
  await $.ui.mount({ plugin: 'osmosis', surface: 'terminal', ...MESSAGE })
  await settleAll(clock)
  const pane = await $.ui.mount(PANE_PROPS)
  expect(await pane.find({ text: 'Today: 1 calls · 1.7k tokens (1.2k in / 500 out) · 7 days: 1.7k' })).toBeDefined()
})

test('at the daily cap no new translation starts and the band says so', async ($, on) => {
  const day = new Date(1_760_000_000_000).toISOString().slice(0, 10)
  const usage = { days: { [day]: { haiku: { calls: 50, input: 90_000, output: 10_000, cacheRead: 0, cacheWrite: 0 } } } }
  const { clock, calls } = world(on, REPLY, { settings: { cap: '100k' }, usage })
  await $.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true })
  const msg = await $.ui.mount({ plugin: 'osmosis', surface: 'terminal', ...MESSAGE })
  await settleAll(clock)
  expect(calls.model).toBe(0)
  expect(await msg.find({ text: 'ENGINE' })).toBeDefined()
  const band = await $.ui.mount(BAND_PROPS)
  expect(await band.find({ text: /daily cap reached/ })).toBeDefined()
})

test('CC-CEDICT sets pinyin and HSK; a word it lacks is dropped', async ($, on) => {
  const { clock } = world(on, 'word|computer|1|电脑|noun|computer\nword|note|1|笔记|noun|note\nword|file|1|文件|noun|file')
  await $.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true })
  const msg = await $.ui.mount({ plugin: 'osmosis', surface: 'terminal', ...MESSAGE })
  await settleAll(clock)
  await msg.press({ key: 'w-0' })
  const pane = await $.ui.mount(PANE_PROPS)
  const text = await paneText(pane)
  for (const part of ['diànnǎo', 'HSK 1', '✓ CC-CEDICT', '电 electric + 脑 brain', '笔记 bǐjì']) expect(text).toContain(part)
  expect(text).not.toContain('文件')
})

const localAnswer = (words: unknown[]) => ({
  status: 200,
  text: JSON.stringify({ choices: [{ message: { content: JSON.stringify(words) } }], usage: { prompt_tokens: 300, completion_tokens: 80 } }),
})

test('the local provider sends a JSON-schema chat request and is corrected by CC-CEDICT', async ($, on) => {
  const words = [item('build', '构建', 'gòngjiàn', 1, { literal: 'build' })]
  const { clock, calls } = world(on, REPLY, { settings: { model: 'local' } }, { history: [BUILD_TEXT], fetch: () => localAnswer(words) })
  await $.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true })
  const msg = await $.ui.mount({ plugin: 'osmosis', surface: 'terminal', component: 'AssistantMessage', props: { text: BUILD_TEXT, isFirstOfReply: true } })
  await settleAll(clock)
  expect(calls.model).toBe(0)
  expect(calls.fetched[0]?.url).toBe('http://127.0.0.1:8080/v1/chat/completions')
  const body = JSON.parse(calls.fetched[0]!.body)
  expect(body.messages[0].role).toBe('system')
  expect(body.response_format.type).toBe('json_schema')
  expect(body.response_format.json_schema.schema.type).toBe('array')
  expect(JSON.stringify(body.response_format.json_schema.schema)).not.toContain('literal')
  await msg.press({ key: 'w-0' })
  const pane = await $.ui.mount(PANE_PROPS)
  const text = await paneText(pane)
  expect(text).toContain('gòujiàn')
  expect(text).not.toContain('noun · HSK')
  expect(text).toContain('构 construct + 建 establish')
  expect(text).toContain('Local model today: 1 calls · 380 tokens')
})

test('a local failure keeps the reply in English, never calls Haiku, and the band says so', async ($, on) => {
  const { clock, calls } = world(on, REPLY, { settings: { model: 'local' } }, { fetch: () => 'throw' })
  await $.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true })
  const msg = await $.ui.mount({ plugin: 'osmosis', surface: 'terminal', ...MESSAGE })
  await settleAll(clock)
  expect(calls.model).toBe(0)
  expect(calls.fetched.length).toBeGreaterThan(0)
  expect(await msg.find({ text: 'ENGINE' })).toBeDefined()
  const band = await $.ui.mount(BAND_PROPS)
  expect(await band.find({ text: /local model unreachable/ })).toBeDefined()
})

test('the status line row hides and shows the status entry', async ($, on) => {
  const { calls } = world(on, REPLY)
  await $.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true })
  expect(calls.status.at(-1)).toMatch(/中文 · beginner/)
  const pane = await $.ui.mount(PANE_PROPS)
  await pane.press({ key: 'status-off' })
  expect(calls.status.at(-1)).toBe(undefined)
  expect((await pane.find({ key: 'status-off' }))?.props.variant).toBe('primary')
  await pane.press({ key: 'level-advanced' })
  expect(calls.status.at(-1)).toBe(undefined)
  await pane.press({ key: 'status-on' })
  expect(calls.status.at(-1)).toMatch(/中文 · advanced/)
  const r = await $.command.run({ command: 'osmosis', args: 'status off', origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 120 } })
  expect(r.text).toBe('Osmosis status line: Off. The \u{1F331} entry under the prompt.')
  expect(calls.status.at(-1)).toBe(undefined)
})

const FIRST_TEXT =
  '- I opened the computer and read the file.\n' + [2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12].map(n => `- Item number ${n} is a plain line.`).join('\n')
const SHORT_TEXT = '- Item one is here and it is fine, with a little more text on this one line.\n- Item two is here as well, and it also has a little more text to read on screen.\n- I opened the computer and read the file.'

const mountMsg = ($: Engine, text: string) =>
  $.ui.mount({ plugin: 'osmosis', surface: 'terminal', viewport: { columns: 100, rows: 40 }, component: 'AssistantMessage', props: { text, isFirstOfReply: true } })

const floating = (tree: unknown) => ((tree as Node).children ?? []).filter(c => (c as Node).props?.position === 'absolute') as Node[]

test('floating cards are the last children of the message root, revealed by the word scope', async ($, on) => {
  const { clock } = world(on, REPLY, {}, { history: [LOW_TEXT] })
  const spoken: string[] = []
  on('audio.speak', async ($, e) => {
    spoken.push(e.text)
    return { value: { via: 'system' as const } }
  })
  await $.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true })
  const msg = await mountMsg($, LOW_TEXT)
  await settleAll(clock)
  const tree = (await msg.drawn()) as Node
  const kids = tree.children ?? []
  const card = kids[kids.length - 1] as Node
  expect(card.props?.position).toBe('absolute')
  expect(card.props?.display).toBe('none')
  expect(card.hover?.display).toBe('flex')
  expect(card.hover?.scope).toBe(hoverOf(tree, 'w-0')?.scope)
  expect(walk(walk(tree, n => n.props?.key === 'k-0')[0], n => n.props?.position === 'absolute')).toHaveLength(0)
  const say = walk(card, n => typeof n.props?.key === 'string' && n.props.key.startsWith('say-'))[0]
  expect(say?.props?.label).toBe('\u{1F50A}')
  await msg.press({ key: say!.props!.key as string })
  await settleAll(clock)
  expect(spoken).toEqual(['电脑'])
})

test('a card goes below a first-row word, above a lower word, and to the bar at the end of a short message', async ($, on) => {
  const { clock } = world(on, REPLY, {}, { history: [FIRST_TEXT, LOW_TEXT, SHORT_TEXT] })
  await $.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true })
  const first = await mountMsg($, FIRST_TEXT)
  const low = await mountMsg($, LOW_TEXT)
  const short = await mountMsg($, SHORT_TEXT)
  await settleAll(clock)
  expect(floating(await first.drawn())[0]?.props?.top).toBe(1)
  expect(floating(await low.drawn())[0]?.props?.top).toBe(1)
  expect(floating(await low.drawn())[0]?.props?.left).toBe(2 + 2 + 'I opened the '.length)
  expect(floating(await short.drawn())).toHaveLength(0)
})

test('in word mode, a word with no room for a floating card gets a bar card; others do not', async ($, on) => {
  const { clock } = world(on, REPLY, {}, { history: [LOW_TEXT, SHORT_TEXT] })
  await $.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true })
  const low = await mountMsg($, LOW_TEXT)
  const short = await mountMsg($, SHORT_TEXT)
  await settleAll(clock)
  const lowScope = hoverOf(await low.drawn(), 'w-0')?.scope
  const shortScope = hoverOf(await short.drawn(), 'w-0')?.scope
  const band = await $.ui.mount(BAND_PROPS)
  const scopes = walk(await band.drawn(), n => n.hover?.display === 'flex').map(n => n.hover?.scope)
  expect(scopes).toContain(shortScope)
  expect(scopes).not.toContain(lowScope)
  expect(await band.find({ text: /Osmosis 中文 · beginner/ })).toBeDefined()
})

test('a copied selection of a translated block pastes as English; other clipboard text is untouched', async ($, on) => {
  const reply = JSON.stringify([item('computer', '电脑', 'diànnǎo', 1), item('note', '笔记', 'bǐjì', 2)])
  const { clock, clip } = world(on, reply)
  await $.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true })
  await $.ui.mount({ plugin: 'osmosis', surface: 'terminal', ...MESSAGE })
  await settleAll(clock)
  clip.value = 'I opened the 电脑 and read\n  the file. Then I wrote a short 笔记'
  await settleAll(clock)
  expect(clip.writes).toEqual(['I opened the computer and read\n  the file. Then I wrote a short note'])
  clip.value = '我的电脑很快'
  await settleAll(clock)
  clip.value = 'hello world'
  await settleAll(clock)
  expect(clip.writes).toHaveLength(1)
})

test('with Copy set to As shown, the clipboard is left alone', async ($, on) => {
  const { clock, clip } = world(on, REPLY, { settings: { copy: 'shown' } })
  await $.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true })
  await $.ui.mount({ plugin: 'osmosis', surface: 'terminal', ...MESSAGE })
  await settleAll(clock)
  clip.value = 'I opened the 电脑 and read the file.'
  await settleAll(clock)
  expect(clip.writes).toHaveLength(0)
  const pane = await $.ui.mount(PANE_PROPS)
  expect((await pane.find({ key: 'copy-shown' }))?.props.variant).toBe('primary')
})

test('a reply whose words are cached draws at once, and stored settings without new keys get defaults', async ($, on) => {
  const words = [{ en: 'computer', occurrence: 1, target: '电脑', romanization: 'diànnǎo', pos: 'noun', gloss: 'computer', literal: '', exampleTarget: '', exampleRomanization: '', exampleEn: '', level: 1, start: TEXT.indexOf('computer'), end: TEXT.indexOf('computer') + 8 }]
  const settings = { isOn: true, level: 'beginner', density: 'normal', show: 'hanzi', isBandOn: true, card: 'word', lang: 'Mandarin' }
  const key = keyFor(TEXT, { ...DEFAULT_SETTINGS, ...settings } as typeof DEFAULT_SETTINGS)
  const { calls } = world(on, REPLY, { settings, cache: [[key, words]] })
  await $.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true })
  const msg = await $.ui.mount({ plugin: 'osmosis', surface: 'terminal', ...MESSAGE })
  expect(await msg.find({ key: 'w-0' })).toBeDefined()
  expect(calls.model).toBe(0)
  const pane = await $.ui.mount(PANE_PROPS)
  for (const k of ['copy-english', 'cap-300k', 'model-haiku', 'status-on']) expect((await pane.find({ key: k }))?.props.variant).toBe('primary')
})

test('the debug trace writes keys and counts to the plugin data folder, never reply text', async ($, on) => {
  mock.env(on, { HOME: '/home/someone' })
  const files: { path: string; text: string }[] = []
  on('fs.write', ($, e) => {
    files.push({ path: e.path, text: e.text })
    return { value: undefined }
  })
  const { clock } = world(on, REPLY)
  await $.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true })
  const r = await $.command.run({ command: 'osmosis', args: 'debug on', origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 120 } })
  expect(r.text).toContain('/home/someone/.claude/plugins/data/osmosis/debug.log')
  await $.ui.mount({ plugin: 'osmosis', surface: 'terminal', ...MESSAGE })
  await settleAll(clock)
  const last = files.at(-1)
  expect(last?.path).toBe('/home/someone/.claude/plugins/data/osmosis/debug.log')
  expect(last?.text).toMatch(/render surface=terminal key=[0-9a-f]{16} tx=ok hit=no final=no queued=no swaps=1 cards=0 bar=1/)
  expect(last?.text).toMatch(/settle key=[0-9a-f]{16} words=1 fresh=true/)
  expect(last?.text).toMatch(/usage haiku in=1000 out=500/)
  expect(last?.text).not.toContain('opened')
  expect(last?.text).not.toContain('电脑')
})

test('/osmosis help lists every setting with its values and effect; the pane shows each description', async ($, on) => {
  world(on, REPLY)
  await $.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true })
  const r = await $.command.run({ command: 'osmosis', args: 'help', origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 120 } })
  expect(r.text).toContain('- coverage natural|maximum: Natural keeps English grammar intact; Maximum swaps more words.')
  expect(r.text).toContain('- cap off|100k|300k|1m: Stop translating after this many Haiku tokens a day.')
  const c = await $.command.run({ command: 'osmosis', args: 'coverage maximum', origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 120 } })
  expect(c.text).toBe('Osmosis coverage: Maximum. Natural keeps English grammar intact; Maximum swaps more words.')
  const pane = await $.ui.mount(PANE_PROPS)
  expect((await pane.find({ key: 'coverage-maximum' }))?.props.variant).toBe('primary')
})

test('setting descriptions stay hidden until a label is pressed; one shows at a time', async ($, on) => {
  world(on, REPLY)
  await $.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true })
  const pane = await $.ui.mount(PANE_PROPS)
  const level = 'Which words swap: HSK 1-2, 3-4, or 5-6.'
  const density = 'How many words swap: 1 per 3 sentences, 1, or 2 per sentence.'
  expect(await paneText(pane)).not.toContain(level)
  await pane.press({ key: 'help-level' })
  expect(await paneText(pane)).toContain(level)
  await pane.press({ key: 'help-density' })
  expect(await paneText(pane)).toContain(density)
  expect(await paneText(pane)).not.toContain(level)
  await pane.press({ key: 'help-density' })
  expect(await paneText(pane)).not.toContain(density)
})

const PHRASE_TEXT = 'If it breaks, run the test again and check the logs for the error.\n\nThat is all for this change; the rest of the project stays the same until the next release goes out next week, as planned with the team.'

test('a phrase at intermediate is kept and drawn as one swap; at beginner it is dropped', async ($, on) => {
  const reply = JSON.stringify([
    { kind: 'phrase', en: 'run the test again', occurrence: 1, target: '再运行测试', romanization: 'zai yunxing ceshi', pos: 'phrase', gloss: 'run the test again', level: 2 },
    { kind: 'word', en: 'logs', occurrence: 1, target: '日志', romanization: 'rìzhì', pos: 'noun', gloss: 'logs', level: 5 },
  ])
  const { clock } = world(on, reply, { settings: { level: 'intermediate' } }, { history: [PHRASE_TEXT] })
  await $.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true })
  const msg = await $.ui.mount({ plugin: 'osmosis', surface: 'terminal', component: 'AssistantMessage', props: { text: PHRASE_TEXT, isFirstOfReply: true } })
  await settleAll(clock)
  const phrase = await msg.find({ key: 'w-0' })
  expect(phrase?.text).toBe('再运行测试')
  expect(await paneText(msg)).toContain('If it breaks, ')
  expect(await paneText(msg)).not.toContain('run the test again')
  await msg.press({ key: 'w-0' })
  const pane = await $.ui.mount(PANE_PROPS)
  expect(await paneText(pane)).toContain('zài yùnxíng cèshì')
})

test('the clipboard watcher runs while a translated message is on screen and stops when it scrolls off', async ($, on) => {
  const { clock, clip } = world(on, REPLY)
  await $.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true })
  const props = { text: TEXT, isFirstOfReply: true, onScreen: { first: 0, last: 20, of: 6 } }
  const msg = await $.ui.mount({ plugin: 'osmosis', surface: 'terminal', component: 'AssistantMessage', props })
  await settleAll(clock)
  expect(clip.reads).toBeGreaterThan(0)
  await msg.redraw({ ...props, onScreen: null })
  const before = clip.reads
  clip.value = 'I opened the 电脑 and read the file.'
  await settleAll(clock)
  expect(clip.reads).toBe(before)
  expect(clip.writes).toHaveLength(0)
  await msg.redraw(props)
  await settleAll(clock)
  expect(clip.reads).toBeGreaterThan(before)
})

const PARAS = ['server', 'window', 'table'].map(
  n => `The ${n} needs a check. It was slow today. We looked at the logs. The fix is small. It ships soon.`,
)
const CHUNKED = PARAS.join('\n\n')
const CHUNK_REPLY: Record<string, string> = { server: '服务器', window: '窗口', table: '表格' }
const answerFor = (prompt: string) => Object.entries(CHUNK_REPLY).find(([en]) => prompt.includes(`The ${en} needs`))

test('a long block is split into chunks; each chunk maps back to the right place; final blocks skip the wait', async ($, on) => {
  const { clock, calls } = world(on, prompt => {
    const hit = answerFor(prompt)
    return hit ? `word|${hit[0]}|1|${hit[1]}|noun|${hit[0]}` : null
  }, {}, { history: [CHUNKED] })
  await $.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true })
  const msg = await $.ui.mount({ plugin: 'osmosis', surface: 'terminal', component: 'AssistantMessage', props: { text: CHUNKED, isFirstOfReply: true } })
  await clock.advance(50)
  await clock.settle()
  expect(calls.model).toBe(3)
  const text = await paneText(msg)
  for (const zh of ['The 服务器 needs', 'The 窗口 needs', 'The 表格 needs']) expect(text).toContain(zh)
})

test('words show as each chunk lands, and a failed chunk leaves only its part in English', async ($, on) => {
  let release: () => void = () => undefined
  const slow = new Promise<void>(done => (release = done))
  const { clock } = world(on, async prompt => {
    const hit = answerFor(prompt)
    if (!hit || hit[0] === 'window') return null
    if (hit[0] === 'table') await slow
    return `word|${hit[0]}|1|${hit[1]}|noun|${hit[0]}`
  }, {}, { history: [CHUNKED] })
  await $.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true })
  const msg = await $.ui.mount({ plugin: 'osmosis', surface: 'terminal', component: 'AssistantMessage', props: { text: CHUNKED, isFirstOfReply: true } })
  await clock.advance(50)
  await clock.settle()
  const early = await paneText(msg)
  expect(early).toContain('The 服务器 needs')
  expect(early).toContain('The window needs')
  expect(early).toContain('The table needs')
  release()
  await clock.advance(50)
  await clock.settle()
  const late = await paneText(msg)
  expect(late).toContain('The 表格 needs')
  expect(late).toContain('The window needs')
})

const ANKI_PY = '/home/someone/Library/Application Support/AnkiProgramFiles/.venv/bin/python'
const DATA = '/home/someone/.claude/plugins/data/osmosis'
const exportRun = (tts: RunAnswer) => (argv: readonly string[]): RunAnswer | undefined => {
  const script = String(argv[1])
  if (argv[1] === '-m') return {}
  if (script.endsWith('tts.py')) return tts
  if (script.endsWith('export-apkg.py')) return { stdout: '{"notes": 1, "audio": 1}' }
  return undefined
}

function exportWorld(on: On, run: (argv: readonly string[]) => RunAnswer | undefined, exported: Record<string, string>) {
  mock.env(on, { HOME: '/home/someone' })
  const written: string[] = []
  on('fs.exists', ($, e) => ({ value: e.path === ANKI_PY || e.path === '/home/someone/Downloads' || written.includes(e.path) }))
  on('fs.write', ($, e) => {
    written.push(e.path)
    return { value: undefined }
  })
  const saved = { 窗口: savedWord('窗口', 'window'), 表格: savedWord('表格', 'table') }
  return world(on, REPLY, { progress: { seen: {}, known: {}, saved, mastery: {}, today: { date: '', count: 0 }, exported } }, { run })
}

const runOsmosis = ($: Engine, args: string) => $.command.run({ command: 'osmosis', args, origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 120 } })

test('/osmosis export voices new saved words in its own venv, builds the deck, then marks them exported', async ($, on) => {
  const { calls } = exportWorld(on, exportRun({ stdout: '1' }), { 窗口: '2026-01-01' })
  await $.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true })
  const r = await runOsmosis($, 'export')
  expect(r.text).toMatch(/^Osmosis export: 1 word saved to \/home\/someone\/Downloads\/osmosis-\d{4}-\d{2}-\d{2}\.apkg\. Open it to import into Anki\. First export: installed edge-tts in /)
  expect(calls.runs.map(x => x.argv.slice(0, 3))).toEqual([
    [ANKI_PY, '-m', 'venv'],
    [`${DATA}/tts/bin/python`, '-m', 'pip'],
    [`${DATA}/tts/bin/python`, expect.stringMatching(/scripts\/tts\.py$/), `${DATA}/audio`],
    [ANKI_PY, expect.stringMatching(/scripts\/export-apkg\.py$/), expect.stringMatching(/\.apkg$/)],
  ])
  const name = expect.stringMatching(/^osmosis-[0-9a-f]{16}\.mp3$/)
  expect(JSON.parse(calls.runs[2]!.stdin)).toEqual([{ text: '表格', name }])
  expect(calls.runs[3]!.argv[3]).toBe(`${DATA}/audio`)
  expect(JSON.parse(calls.runs[3]!.stdin)).toEqual([{ hanzi: '表格', pinyin: '', meaning: 'table', example: '', exampleEn: '', audio: name, exampleAudio: '' }])
  expect((await runOsmosis($, 'export')).text).toContain('no new saved Mandarin words')
  const all = await runOsmosis($, 'export all')
  expect(all.text).toContain('2 words saved')
  expect(all.text).not.toContain('installed edge-tts')
  expect(calls.runs.filter(x => x.argv[1] === '-m')).toHaveLength(2)
})

test('/osmosis export still saves the deck when the voice fails, and says why', async ($, on) => {
  const { calls } = exportWorld(on, exportRun({ exitCode: 1, stderr: 'Traceback\nClientConnectorError: offline' }), {})
  await $.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true })
  const r = await runOsmosis($, 'export')
  expect(r.text).toMatch(/^Osmosis export: 2 words saved to .*\.apkg \(no audio: ClientConnectorError: offline; \/osmosis export all adds it later\)\. Open it to import into Anki\.$/)
  expect(calls.runs.at(-1)?.argv[1]).toMatch(/export-apkg\.py$/)
  expect(calls.runs.find(x => x.argv.includes('install'))?.argv.at(-1)).toBe('edge-tts==7.3.1')
})

test('/osmosis export without Anki says so and writes nothing', async ($, on) => {
  mock.env(on, { HOME: '/home/someone' })
  on('fs.exists', () => ({ value: false }))
  const toasts: string[] = []
  on('ui.toast', ($, e) => {
    toasts.push(e.text)
    return { value: undefined }
  })
  const { calls, clock } = world(on, REPLY, { progress: { seen: {}, known: {}, saved: { 表格: savedWord('表格', 'table') }, mastery: {}, today: { date: '', count: 0 } } }, { run: exportRun({}) })
  await $.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true })
  const r = await $.command.run({ command: 'osmosis', args: 'export', origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 120 } })
  expect(r.text).toBe('Osmosis export: Anki not found. Install Anki 25.x from apps.ankiweb.net.')
  await $.command.run({ command: 'osmosis', args: 'bank', origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 120 } })
  const pane = await $.ui.mount(PANE_PROPS)
  await pane.press({ key: 'export' })
  await settleAll(clock)
  expect(toasts).toEqual([r.text])
  expect(calls.runs).toEqual([])
})
