// Run with: node --test codex/
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { parseCedict, parseHsk } from '../../hooks/dict.ts'
import * as lib from '../lib.mjs'

const STOP = fileURLToPath(new URL('../stop.mjs', import.meta.url))
const DICT = {
  rows: parseCedict('电脑\tdiànnǎo\tcomputer\n电\tdiàn\telectricity\n脑\tnǎo\tbrain\n邮件\tyóujiàn\tmail\n邮\tyóu\tpost\n件\tjiàn\titem\n'),
  hsk: parseHsk('电脑\t1\n'),
}
const REPLY = 'The computer runs the test suite every night. If a test fails, the build stops and you get an email with the error.'
const MODEL_REPLY = 'word|computer|1|电脑|noun|computer\nword|email|1|邮件|noun|email\nword|error|1|错误字|noun|error'
const tempDir = () => mkdtempSync(join(tmpdir(), 'osmosis-test-'))
const stub = (text = MODEL_REPLY) => {
  const calls = []
  const fn = async (prompt, s) => {
    calls.push({ prompt, s })
    return { ok: true, text, usage: { input: 1000, output: 20, cacheRead: 0, cacheWrite: 0 } }
  }
  return { fn, calls }
}

test('settings fall back to defaults for a missing, broken or invalid file', () => {
  assert.deepEqual(lib.parseSettings('not json'), lib.DEFAULTS)
  assert.deepEqual(lib.parseSettings(null), lib.DEFAULTS)
  const s = lib.parseSettings({ isOn: 'yes', level: 'expert', density: 'high', model: 'rm -rf', cap: '300k' })
  assert.equal(s.isOn, true)
  assert.equal(s.level, 'beginner')
  assert.equal(s.density, 'high')
  assert.equal(s.model, 'gpt-6-luna')
  assert.equal(s.cap, '300k')
})

test('commands change one setting and say so in one line', () => {
  const s = lib.DEFAULTS
  assert.deepEqual(lib.applyCommand(s, ['level', 'intermediate']), { settings: { ...s, level: 'intermediate' }, message: 'Osmosis level: intermediate.' })
  assert.equal(lib.applyCommand(s, ['off']).settings.isOn, false)
  assert.equal(lib.applyCommand(s, ['model', 'local']).settings.model, 'local')
  assert.equal(lib.applyCommand(s, ['cap', '100K']).settings.cap, '100k')
  assert.equal(lib.applyCommand(s, ['codex', 'auto']).settings.codex, '')
  assert.match(lib.applyCommand(s, ['level', 'expert']).error, /beginner, intermediate or advanced/)
  assert.match(lib.applyCommand(s, ['endpoint', 'localhost']).error, /http/)
  assert.match(lib.applyCommand(s, ['frobnicate']).error, /unknown setting/)
  assert.equal(lib.applyCommand(s, []).message, null)
  assert.equal(lib.applyCommand(s, ['help']).message, lib.HELP)
})

test('the data folder is PLUGIN_DATA, else derived from the install path, else ~/.codex/osmosis', () => {
  assert.equal(lib.dataDirFor({ PLUGIN_DATA: '/d' }, '/x/codex/settings.mjs'), '/d')
  assert.equal(lib.dataDirFor({}, '/h/.codex/plugins/cache/osmosis/osmosis/0.2.4/codex/settings.mjs'), '/h/.codex/plugins/data/osmosis-osmosis')
  assert.equal(lib.dataDirFor({ CODEX_HOME: '/ch' }, '/src/osmosis/codex/settings.mjs'), '/ch/osmosis')
  assert.equal(lib.dataDirFor({}, '/src/osmosis/codex/settings.mjs', '/home/me'), '/home/me/.codex/osmosis')
})

test('the recursion guard spots the word-picking child by env or by its folder', () => {
  assert.equal(lib.isChildRun({ cwd: '/repo' }, { OSMOSIS_CHILD: '1' }), true)
  assert.equal(lib.isChildRun({ cwd: `/data/${lib.CHILD_DIR}` }, {}), true)
  assert.equal(lib.isChildRun({ cwd: '/repo' }, {}), false)
  assert.equal(lib.isChildRun(null, {}), false)
})

test('short and code-heavy replies get no card', () => {
  const s = lib.DEFAULTS
  assert.equal(lib.cardSource('Done.', s), null)
  assert.equal(lib.cardSource(null, s), null)
  const code = `Here:\n\n\`\`\`js\n${'const computer = 1\n'.repeat(30)}\`\`\``
  assert.equal(lib.cardSource(code, s), null)
  const src = lib.cardSource(REPLY, s)
  assert.equal(src.text, REPLY)
  assert.ok(src.cap >= 1 && src.cap <= lib.CARD_WORDS.normal)
  assert.match(lib.buildPrompt(src, s), /Item limit: \d+; phrase limit: 0/)
})

test('the card caps words by density', () => {
  const long = Array.from({ length: 12 }, (_, i) => `The computer number ${i} runs a test.`).join(' ')
  assert.equal(lib.cardSource(long, { ...lib.DEFAULTS, density: 'low' }).cap, lib.CARD_WORDS.low)
  assert.equal(lib.cardSource(long, { ...lib.DEFAULTS, density: 'high' }).cap, lib.CARD_WORDS.high)
})

test('model words are checked against CC-CEDICT: the dictionary sets pinyin and HSK, unknown words drop', () => {
  const src = { text: REPLY, cap: 4 }
  const words = lib.pickWords(MODEL_REPLY, src, lib.DEFAULTS, DICT)
  assert.deepEqual(words.map(w => [w.target, w.romanization, w.level, w.verified]), [
    ['电脑', 'diànnǎo', 1, true],
    ['邮件', 'yóujiàn', null, true],
  ])
  assert.equal(lib.pickWords('not a reply {', src, lib.DEFAULTS, DICT), null)
})

test('the card has one line per word under a header', () => {
  const words = lib.pickWords(MODEL_REPLY, { text: REPLY, cap: 4 }, lib.DEFAULTS, DICT)
  assert.equal(
    lib.formatCard([...words, words[0]], lib.DEFAULTS),
    '\u{1F331} 中文 · beginner\n电脑 diànnǎo · computer · HSK 1 · 电 electricity + 脑 brain\n邮件 yóujiàn · email · 邮 post + 件 item',
  )
  assert.equal(lib.formatCard([], lib.DEFAULTS), null)
})

test('codex exec runs without hooks, plugins or saved sessions, in the child folder', () => {
  const args = lib.execArgs({ model: 'gpt-6-luna', childDir: '/d/osmosis-child', rulesPath: '/d/rules.txt' })
  for (const flag of ['--ephemeral', '--ignore-user-config', '--skip-git-repo-check']) assert.ok(args.includes(flag), flag)
  const disabled = args.flatMap((a, i) => (a === '--disable' ? [args[i + 1]] : []))
  assert.ok(disabled.includes('hooks') && disabled.includes('plugins'))
  assert.deepEqual(args.slice(args.indexOf('-m'), args.indexOf('-m') + 2), ['-m', 'gpt-6-luna'])
  assert.deepEqual(args.slice(args.indexOf('-C'), args.indexOf('-C') + 2), ['-C', '/d/osmosis-child'])
  assert.ok(args.includes('model_instructions_file="/d/rules.txt"'))
  assert.equal(args.at(-1), '-')
})

test('codex exec JSONL gives the last agent message and usage, or the error', () => {
  const ok = [
    '{"type":"thread.started","thread_id":"t"}',
    '{"type":"item.completed","item":{"id":"i0","type":"agent_message","text":"word|computer|1|电脑|noun|computer"}}',
    '{"type":"turn.completed","usage":{"input_tokens":5000,"cached_input_tokens":3000,"output_tokens":30}}',
  ].join('\n')
  assert.deepEqual(lib.parseExecJsonl(ok), { ok: true, text: 'word|computer|1|电脑|noun|computer', usage: { input: 5000, output: 30, cacheRead: 0, cacheWrite: 0 } })
  const failed = '{"type":"turn.failed","error":{"message":"model not supported"}}'
  assert.deepEqual(lib.parseExecJsonl(failed), { ok: false, reason: 'model not supported', usage: null })
  assert.equal(lib.parseExecJsonl('').reason, 'no-reply')
})

test('the newest codex binary wins', () => {
  assert.deepEqual(lib.parseVersion('codex-cli 0.163.0-alpha.10.2'), [0, 163, 0])
  const found = [
    { bin: 'codex', version: lib.parseVersion('codex-cli 0.153.4') },
    { bin: '/app/codex', version: lib.parseVersion('codex-cli 0.163.0') },
    { bin: 'missing', version: null },
  ]
  assert.equal(lib.newest(found), '/app/codex')
  assert.equal(lib.newest([{ bin: 'missing', version: null }]), null)
})

test('the Stop hook returns a card and records usage', async () => {
  const dataDir = tempDir()
  const model = stub()
  const card = await lib.runStop({ cwd: '/repo', last_assistant_message: REPLY }, { env: {}, dataDir, deadline: Date.now() + 5000, callModel: model.fn, dict: DICT })
  assert.match(card, /^\u{1F331} 中文 · beginner\n电脑 diànnǎo · computer · HSK 1/u)
  assert.equal(model.calls.length, 1)
  const usage = JSON.parse(readFileSync(join(dataDir, 'usage.json'), 'utf8'))
  assert.equal(Object.values(usage.days)[0].codex.calls, 1)
  assert.equal(JSON.parse(readFileSync(join(dataDir, 'last.json'), 'utf8')).status, 'card')
})

test('the Stop hook calls no model when off, capped, or inside the child', async () => {
  const run = async (dataDir, input, env = {}) => {
    const model = stub()
    const card = await lib.runStop(input, { env, dataDir, deadline: Date.now() + 5000, callModel: model.fn, dict: DICT })
    return { card, calls: model.calls.length }
  }
  const input = { cwd: '/repo', last_assistant_message: REPLY }
  assert.deepEqual(await run(tempDir(), input, { OSMOSIS_CHILD: '1' }), { card: null, calls: 0 })
  assert.deepEqual(await run(tempDir(), { ...input, cwd: `/x/${lib.CHILD_DIR}` }), { card: null, calls: 0 })
  const off = tempDir()
  writeFileSync(join(off, 'settings.json'), JSON.stringify({ isOn: false }))
  assert.deepEqual(await run(off, input), { card: null, calls: 0 })
  const capped = tempDir()
  writeFileSync(join(capped, 'settings.json'), JSON.stringify({ cap: '100k' }))
  writeFileSync(join(capped, 'usage.json'), JSON.stringify({ days: { [lib.today()]: { codex: { calls: 9, input: 100_000, output: 0, cacheRead: 0, cacheWrite: 0 } } } }))
  assert.deepEqual(await run(capped, input), { card: null, calls: 0 })
})

test('a failed model call gives no card and notes the reason', async () => {
  const dataDir = tempDir()
  const card = await lib.runStop({ cwd: '/repo', last_assistant_message: REPLY }, { env: {}, dataDir, deadline: Date.now() + 5000, callModel: async () => ({ ok: false, reason: 'boom' }), dict: DICT })
  assert.equal(card, null)
  assert.deepEqual(JSON.parse(readFileSync(join(dataDir, 'last.json'), 'utf8')).reason, 'boom')
})

test('the local model gets a JSON schema, and a retry without it on HTTP 400', async () => {
  const bodies = []
  const fetchImpl = async (url, init) => {
    bodies.push({ url, body: JSON.parse(init.body) })
    if (bodies.length === 1) return new Response('no schema', { status: 400 })
    return new Response(JSON.stringify({ choices: [{ message: { content: '[]' } }], usage: { prompt_tokens: 10, completion_tokens: 2 } }))
  }
  const s = { ...lib.DEFAULTS, model: 'local', endpoint: 'http://127.0.0.1:9/v1/' }
  const r = await lib.callLocal('prompt', s, { deadline: Date.now() + 5000 }, fetchImpl)
  assert.deepEqual(r, { ok: true, text: '[]', usage: { input: 10, output: 2, cacheRead: 0, cacheWrite: 0 } })
  assert.equal(bodies[0].url, 'http://127.0.0.1:9/v1/chat/completions')
  assert.ok(bodies[0].body.response_format)
  assert.equal(bodies[1].body.response_format, undefined)
  assert.equal((await lib.callLocal('p', { ...s, endpoint: 'nope' }, { deadline: Date.now() + 5000 }, fetchImpl)).reason, 'local-bad-endpoint')
})

test('the Codex manifest points at files that exist, and only a Stop hook is declared', () => {
  const root = fileURLToPath(new URL('../../', import.meta.url))
  const manifest = JSON.parse(readFileSync(join(root, '.codex-plugin/plugin.json'), 'utf8'))
  const claude = JSON.parse(readFileSync(join(root, '.claude-plugin/plugin.json'), 'utf8'))
  assert.equal(manifest.version, claude.version)
  for (const p of [manifest.skills, manifest.hooks, 'codex/skills/osmosis/SKILL.md', 'codex/skills/osmosis/scripts/settings.mjs']) assert.ok(existsSync(join(root, p)), p)
  const hooks = JSON.parse(readFileSync(join(root, manifest.hooks), 'utf8')).hooks
  assert.deepEqual(Object.keys(hooks), ['Stop'])
  assert.match(hooks.Stop[0].hooks[0].command, /\$\{PLUGIN_ROOT\}\/codex\/stop\.mjs/)
})

test('stop.mjs prints nothing and exits 0 for the child, bad input and short replies', () => {
  const dataDir = tempDir()
  const run = (input, env = {}) => spawnSync(process.execPath, [STOP], { input, encoding: 'utf8', env: { ...process.env, PLUGIN_DATA: dataDir, ...env } })
  for (const r of [
    run(JSON.stringify({ hook_event_name: 'Stop', cwd: '/repo', last_assistant_message: REPLY }), { OSMOSIS_CHILD: '1' }),
    run('{not json'),
    run(JSON.stringify({ hook_event_name: 'Stop', cwd: '/repo', last_assistant_message: 'Done.' })),
    run(JSON.stringify({ hook_event_name: 'PreToolUse', cwd: '/repo', last_assistant_message: REPLY })),
  ]) {
    assert.equal(r.status, 0)
    assert.equal(r.stdout, '')
  }
})
