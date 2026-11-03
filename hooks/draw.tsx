import type {
  BoxProps,
  ButtonProps,
  ElementConstructor,
  LinkProps,
  MarkdownProps,
  RenderElement,
  TextProps,
} from 'claude-code'

import type {
  OsmosisExample,
  OsmosisProgress,
  OsmosisQuiz,
  OsmosisRecentWord,
  OsmosisSettings,
  OsmosisUsage,
  OsmosisWord,
} from '../types'
import { SETTING_ROWS, SPEAKER, cardLines, cardRows, cellWidth, fitCells, langInfo, padCells, scopeFor, shownExtras, shownText, showParts, SHOW_PARTS, toggleShow } from './core'
import { usageLines } from './providers'
import type { CardPlace, Part, Segment, Token } from './core'

export type ExampleView = OsmosisExample | { status: 'loading' } | { status: 'cap' }

export type Els = {
  Box: ElementConstructor<BoxProps>
  Text: ElementConstructor<TextProps>
  Button: ElementConstructor<ButtonProps>
  Markdown: ElementConstructor<MarkdownProps>
  Link: ElementConstructor<LinkProps>
}

export const LEARN_COLOR = 'suggestion'
const CARD_BACKGROUND = 'inverseText'
const BULLET = '⏺'

function drawPart({ Text, Link }: Els, p: Part) {
  if (p.kind === 'bold') return <Text bold>{p.text}</Text>
  if (p.kind === 'italic') return <Text italic>{p.text}</Text>
  if (p.kind === 'code') return <Text color="permission">{p.text}</Text>
  if (p.kind === 'link' || p.kind === 'url')
    return (
      <Link href={p.href ?? p.text}>
        <Text color="suggestion" underline>{p.text}</Text>
      </Link>
    )
  return p.text
}

function drawWord(els: Els, w: OsmosisWord, scope: string, s: OsmosisSettings, key: string, onPress: () => void, isPinned = false) {
  const { Box, Button, Text } = els
  const shown = shownText(w, s.show)
  const extras = shownExtras(w, s.show)
  // A graphical surface draws a button as plain text, ignoring colors inside it, but it can dim
  // one: there the word and its reading are two buttons that hover and press as one.
  if (isPinned)
    return (
      <Box flexDirection="row" flexShrink={0}>
        <Button key={key} label={shown} plain hover={{ scope, inverse: true }} onPress={onPress} />
        {extras.length ? <Button key={`${key}-more`} label={extras.join(' ')} plain dimColor hover={{ scope, inverse: true }} onPress={onPress} /> : null}
      </Box>
    )
  return (
    <Button key={key} label={`${shown} (${w.en})`} plain hover={{ scope, inverse: true }} onPress={onPress}>
      <Text color={LEARN_COLOR} underline>{shown}</Text>
      {extras.length ? <Text dimColor> {extras.join(' ')}</Text> : null}
    </Button>
  )
}

function drawCard({ Box, Text, Button }: Els, w: OsmosisWord, scope: string, p: Extract<CardPlace, { kind: 'above' | 'below' }>, say: () => void) {
  const lines = cardLines(w)
  const rows = cardRows(lines, p.inner)
  const head = cellWidth(w.target)
  return (
    <Box
      position="absolute"
      top={p.top}
      left={p.left}
      display="none"
      hover={{ scope, display: 'flex' }}
      borderStyle="round"
      borderDimColor
      flexDirection="column"
      width={p.inner + 4}
      flexShrink={0}
    >
      {rows.map((row, i) =>
        i === 0 ? (
          <Box flexDirection="row">
            <Text>
              {' '}
              <Text bold color={LEARN_COLOR}>{w.target}</Text>
              {`${padCells(row.text.slice(w.target.length), Math.max(0, p.inner - head - 2))}`}
            </Text>
            <Button key={`say-${scope}`} label={SPEAKER} plain onPress={say}>{SPEAKER}</Button>
            <Text> </Text>
          </Box>
        ) : (
          <Text dimColor={row.line === lines.length - 1}>{` ${padCells(row.text, p.inner)} `}</Text>
        ),
      )}
    </Box>
  )
}

// A graphical surface lays text out in its own font, so cell offsets along a line miss the
// word: a card above is pinned to the word itself. One below is drawn last in the message,
// at the word's row, so the words after it cannot paint over it. Both have a solid background.
function drawPinnedCard({ Box, Text, Button }: Els, w: OsmosisWord, scope: string, p: Extract<CardPlace, { kind: 'above' | 'below' }>, say: () => void) {
  const lines = cardLines(w)
  const place = p.kind === 'above' ? { bottom: 1, left: p.shift ?? 0 } : { top: p.top, left: p.left }
  const speaker = <Button key={`say-${scope}`} label={SPEAKER} plain onPress={say}>{SPEAKER}</Button>
  const head = (
    <Text>
      <Text bold color={LEARN_COLOR}>{w.target}</Text>
      {w.romanization ? ` ${w.romanization}` : ''}
    </Text>
  )
  return (
    <Box
      position="absolute"
      {...place}
      display="none"
      hover={{ scope, display: 'flex' }}
      borderStyle="round"
      borderDimColor
      backgroundColor={CARD_BACKGROUND}
      flexDirection="column"
      paddingX={1}
      width={p.inner + 4}
      flexShrink={0}
    >
      <Box flexDirection="row" gap={1}>
        {head}
        {speaker}
      </Box>
      {lines.slice(1).map((line, i) => (
        <Text dimColor={i === lines.length - 2} wrap="truncate-end">{line}</Text>
      ))}
    </Box>
  )
}

function drawToken(
  els: Els,
  t: Token,
  words: readonly OsmosisWord[],
  msgKey: string,
  s: OsmosisSettings,
  pick: (i: number) => void,
  pinned: Map<number, CardPlace> | null,
  say: (i: number) => void,
) {
  const { Box, Text } = els
  if (t.kind === 'swap') {
    const w = words[t.index]!
    const plan = pinned?.get(t.index)
    return (
      <Box key={`k-${t.index}`} flexDirection="row" flexShrink={0}>
        {drawWord(els, w, scopeFor(msgKey, t.index), s, `w-${t.index}`, () => pick(t.index), pinned !== null)}
        {t.trailing ? <Text>{t.trailing}</Text> : null}
        {plan?.kind === 'above' ? drawPinnedCard(els, w, scopeFor(msgKey, t.index), plan, () => say(t.index)) : null}
      </Box>
    )
  }
  if (t.parts.length === 1 && t.parts[0]!.kind === 'text') return <Text>{t.parts[0]!.text}</Text>
  return <Text>{t.parts.map(p => drawPart(els, p))}</Text>
}

export function drawMessage(
  els: Els,
  segs: Segment[],
  words: readonly OsmosisWord[],
  msgKey: string,
  isFirst: boolean,
  s: OsmosisSettings,
  pick: (i: number) => void,
  cards: Map<number, CardPlace> | null,
  say: (i: number) => void = () => {},
  isPinned = false,
): RenderElement {
  const { Box, Text, Markdown } = els
  const pinned = isPinned ? cards : null
  return (
    // On a graphical surface the row above the reply is padding, not margin: a margin row belongs to the
    // app's message wrapper, where a pointer moving off a word never ends its hover.
    <Box
      flexDirection="row"
      alignItems="flex-start"
      {...(isPinned ? { paddingTop: 1 } : { marginTop: 1 })}
      {...(pinned ? { paddingBottom: Math.max(0, ...[...pinned.values()].map(p => (p.kind === 'bar' ? 0 : (p.spare ?? 0)))) } : {})}
    >
      <Box minWidth={2} flexShrink={0}>
        <Text color="text">{isFirst ? BULLET : ' '}</Text>
      </Box>
      <Box flexDirection="column" flexGrow={1} flexShrink={1} gap={1}>
        {segs.map(seg =>
          seg.kind === 'md' ? (
            <Markdown text={seg.text} />
          ) : (
            <Box flexDirection="column">
              {seg.lines.map(line => (
                <Box flexDirection="row" alignItems="flex-start" paddingLeft={line.indent}>
                  {line.marker !== null ? (
                    <Box flexShrink={0}>
                      <Text>{`${line.marker} `}</Text>
                    </Box>
                  ) : null}
                  <Box flexDirection="row" flexWrap="wrap" flexGrow={1} flexShrink={1}>
                    {line.tokens.map(t => drawToken(els, t, words, msgKey, s, pick, pinned, say))}
                  </Box>
                </Box>
              ))}
            </Box>
          ),
        )}
      </Box>
      {cards
        ? [...cards.entries()].map(([index, plan]) =>
            plan.kind === 'bar' || (isPinned && plan.kind === 'above')
              ? null
              : isPinned
                ? drawPinnedCard(els, words[index]!, scopeFor(msgKey, index), plan, () => say(index))
                : drawCard(els, words[index]!, scopeFor(msgKey, index), plan, () => say(index)),
          )
        : null}
    </Box>
  ) as RenderElement
}

// ---------- the band ----------


export function cardLine(w: OsmosisWord): { head: string; rest: string } {
  const bits = [w.pos, w.gloss].filter(Boolean).join('  ')
  const tail = [w.literal, w.level ? `HSK ${w.level}` : '', 'click for more'].filter(Boolean).join(' · ')
  return { head: w.target, rest: ` ${w.romanization}  ${bits}  · ${tail}  ` }
}

export function drawBand(
  els: Els,
  recent: readonly OsmosisRecentWord[],
  s: OsmosisSettings,
  todayCount: number,
  columns: number,
  notice = '',
  fallbacks: readonly string[] = [],
): RenderElement {
  const { Box, Text } = els
  const info = langInfo(s.lang)
  const compact = notice
    ? `Osmosis ${info.label} · ${notice} · replies stay in English · /osmosis`
    : `Osmosis ${info.label} · ${s.level} · ${todayCount} words today · /osmosis`
  return (
    <Box flexDirection="row">
      <Box flexDirection="row" flexShrink={0}>
        {(s.card === 'word' ? recent.filter(r => fallbacks.includes(scopeFor(r.key, r.index))) : recent).map(r => {
          const { head, rest } = cardLine(r.word)
          const room = Math.max(10, columns - cellWidth(head) - 2)
          return (
            <Box display="none" hover={{ scope: scopeFor(r.key, r.index), display: 'flex' }} flexShrink={0}>
              <Text wrap="truncate-end">
                <Text bold color={LEARN_COLOR}>{head}</Text>
                <Text>{fitCells(rest, room, 'cut')}</Text>
              </Text>
            </Box>
          )
        })}
      </Box>
      <Text dimColor wrap="truncate-end">{compact}</Text>
    </Box>
  ) as RenderElement
}

// ---------- the pane ----------

export type PaneActions = {
  speak: (w: OsmosisWord) => void
  toggleSave: (w: OsmosisWord) => void
  toggleKnown: (w: OsmosisWord) => void
  step: (delta: number) => void
  pick: (i: number) => void
  close: () => void
  home: () => void
  unsave: (target: string) => void
  answer: (choice: number) => void
  retake: () => void
  setSettings: (patch: Partial<OsmosisSettings>) => void
  openView: (view: 'bank' | 'quiz') => void
  toggleHelp: (row: string) => void
  exportAnki: () => void
}

// A desktop draws a Button as a filled native button, a row of which crowds the narrow pane: there a
// choice is a plain button, the current one at full strength and the rest dim.
function choiceLook(isCurrent: boolean, isPlain: boolean) {
  return isPlain ? { plain: true as const, dimColor: !isCurrent } : { variant: isCurrent ? ('primary' as const) : ('secondary' as const) }
}

// Checkboxes, not one choice: a word can show any mix of its parts.
function showRow({ Box, Button, Text }: Els, s: OsmosisSettings, act: PaneActions, isOpen: boolean, isPlain: boolean) {
  const parts = showParts(s.show)
  return (
    <Box flexDirection="row">
      <Box width={14} flexShrink={0}>
        <Button key="help-show" plain dimColor={!isOpen} onPress={() => act.toggleHelp('show')}>
          <Text dimColor>{isOpen ? '\u25be ' : '\u25b8 '}</Text>
          Show
        </Button>
      </Box>
      <Box flexDirection="row" flexWrap="wrap" columnGap={1} flexGrow={1} flexShrink={1}>
        {SHOW_PARTS.map(([part, label]) => (
          <Button
            key={`show-${part}`}
            label={`${parts.has(part) ? '\u2611' : '\u2610'} ${label}`}
            {...choiceLook(parts.has(part), isPlain)}
            onPress={() => act.setSettings({ show: toggleShow(s.show, part) })}
          />
        ))}
      </Box>
    </Box>
  )
}

function choiceRow<V extends string>(
  { Box, Text, Button }: Els,
  title: string,
  name: string,
  options: readonly (readonly [V, string])[],
  current: V,
  choose: (v: V) => void,
  hotkeyFor: (v: V) => string | undefined,
  isOpen: boolean,
  toggleHelp: () => void,
  isPlain: boolean,
) {
  return (
    <Box flexDirection="row">
      <Box width={14} flexShrink={0}>
        <Button key={`help-${name}`} plain dimColor={!isOpen} onPress={toggleHelp}>
          <Text dimColor>{isOpen ? '\u25be ' : '\u25b8 '}</Text>
          {title}
        </Button>
      </Box>
      <Box flexDirection="row" flexWrap="wrap" columnGap={1} flexGrow={1} flexShrink={1}>
        {options.map(([value, label]) => {
          const hotkey = hotkeyFor(value)
          const look = choiceLook(value === current, isPlain)
          return hotkey === undefined ? (
            <Button key={`${name}-${value}`} label={label} {...look} onPress={() => choose(value)} />
          ) : (
            <Button key={`${name}-${value}`} label={label} hotkey={hotkey} {...look} onPress={() => choose(value)} />
          )
        })}
      </Box>
    </Box>
  )
}

export function drawSettings(els: Els, s: OsmosisSettings, act: PaneActions, copyNote = '', help: string | null = null, isPlain = false) {
  const { Box, Text, Button } = els
  return (
    <Box flexDirection="column">
      <Text bold>Settings</Text>
      {SETTING_ROWS.map(row => {
        const current = row.values.find(v => v[2] === s[row.key])?.[0] ?? ''
        const toggle = row.key === 'isOn' ? 'o' : row.key === 'isBandOn' ? 'v' : undefined
        return (
          <Box flexDirection="column">
            {row.key === 'show' ? showRow(els, s, act, help === row.keyName, isPlain) : choiceRow(
              els,
              row.label,
              row.keyName,
              row.values.map(v => [v[0], v[1]] as const),
              current,
              v => act.setSettings({ [row.key]: row.values.find(x => x[0] === v)?.[2] } as Partial<OsmosisSettings>),
              v => (toggle && v !== current ? toggle : undefined),
              help === row.keyName,
              () => act.toggleHelp(row.keyName),
              isPlain,
            )}
            {help === row.keyName ? <Text dimColor>{`  ${row.help}`}</Text> : null}
            {row.key === 'copy' && s.copy === 'english' && copyNote ? <Text dimColor>{`  ${copyNote}`}</Text> : null}
            {row.key === 'model' && s.model === 'local' ? (
              <Text dimColor>{`  Local endpoint: ${s.endpoint}${s.localModel ? ` (${s.localModel})` : ''} \u00b7 change with /osmosis endpoint <url>`}</Text>
            ) : null}
          </Box>
        )
      })}
      <Box flexDirection="row" columnGap={1} marginTop={1}>
        <Button key="view-bank" label="Word bank" hotkey="w" {...(isPlain ? { plain: true as const } : {})} onPress={() => act.openView('bank')} />
        <Button key="view-quiz" label="Quiz" hotkey="q" {...(isPlain ? { plain: true as const } : {})} onPress={() => act.openView('quiz')} />
      </Box>
      <Text dimColor>{`o: on/off \u00b7 v: hover bar \u00b7 w: word bank \u00b7 q: quiz \u00b7 ${langInfo(s.lang).name}`}</Text>
    </Box>
  )
}

export function drawHome(
  els: Els,
  s: OsmosisSettings,
  words: readonly OsmosisWord[],
  selected: number | null,
  progress: OsmosisProgress,
  act: PaneActions,
  example: ExampleView | null = null,
  usage: OsmosisUsage = { days: {} },
  today = '',
  copyNote = '',
  help: string | null = null,
  isPlain = false,
): RenderElement {
  const { Box, Text, Button } = els
  const w = selected === null ? undefined : words[selected]
  const seen = w ? progress.seen[w.target]?.n ?? 0 : 0
  const isSaved = w ? progress.saved[w.target] !== undefined : false
  const isKnown = w ? progress.known[w.target] === true : false
  return (
    <Box flexDirection="column" gap={1}>
      {w ? (
        <Box flexDirection="column">
          <Text>
            <Text bold color={LEARN_COLOR}>{w.target}</Text>
            {`  ${w.romanization}  `}
            <Text dimColor>{[w.pos, w.level ? `HSK ${w.level}` : ''].filter(Boolean).join(' · ')}</Text>
          </Text>
          <Text>{w.gloss}</Text>
          {w.literal ? <Text dimColor>{w.literal}</Text> : null}
          {w.verified === true ? (
            <Text dimColor>{`\u2713 CC-CEDICT${w.dictGloss && w.dictGloss !== w.gloss ? `: ${w.dictGloss}` : ''}`}</Text>
          ) : w.verified === false ? (
            <Text dimColor>unverified</Text>
          ) : null}
        </Box>
      ) : (
        <Text dimColor>Hover a highlighted word in a reply to peek; click it (or pick one below) for more. Esc or /osmosis close hides this pane.</Text>
      )}
      {w && example ? (
        example.status === 'ok' ? (
          <Box flexDirection="column">
            <Text>{example.target}</Text>
            {example.romanization ? <Text dimColor>{example.romanization}</Text> : null}
            {example.en ? <Text italic>{example.en}</Text> : null}
          </Box>
        ) : (
          <Text dimColor>
            {example.status === 'loading'
              ? 'loading example...'
              : example.status === 'cap'
                ? 'Daily cap reached: no new example today.'
                : 'No example available.'}
          </Text>
        )
      ) : null}
      {w ? (
        <Text dimColor>
          {`English: "${w.en}" · seen ${seen}x${isSaved ? ' · saved' : ''}${isKnown ? ' · known' : ''}`}
        </Text>
      ) : null}
      {w ? (
        <Box flexDirection="row" flexWrap="wrap" columnGap={2}>
          <Button key="speak" hotkey="s" plain onPress={() => act.speak(w)}>Speak</Button>
          <Button key="save" hotkey="b" plain onPress={() => act.toggleSave(w)}>{isSaved ? 'Unsave' : 'Save to word bank'}</Button>
          <Button key="known" hotkey="k" plain onPress={() => act.toggleKnown(w)}>{isKnown ? 'Not known yet' : 'I know this'}</Button>
          <Button key="prev" hotkey="p" plain onPress={() => act.step(-1)}>Prev</Button>
          <Button key="next" hotkey="n" plain onPress={() => act.step(1)}>Next word</Button>
          <Button key="close" hotkey="x" plain role="dismiss" onPress={act.close}>Close</Button>
        </Box>
      ) : (
        <Box flexDirection="row">
          <Button key="close" hotkey="x" plain role="dismiss" onPress={act.close}>Close</Button>
        </Box>
      )}
      <Box flexDirection="column">
        <Text bold>{words.length ? "This reply's words" : 'No translated reply yet.'}</Text>
        {words.map((one, i) => (
          <Button key={`pick-${i}`} plain onPress={() => act.pick(i)}>
            {i === selected ? '› ' : '  '}
            <Text color={LEARN_COLOR}>{one.target}</Text>
            {` ${one.romanization} `}
            <Text dimColor>{one.gloss}</Text>
          </Button>
        ))}
      </Box>
      {drawSettings(els, s, act, copyNote, help, isPlain)}
      {today ? (
        <Box flexDirection="column">
          {usageLines(usage, today).map(line => (
            <Text dimColor>{line}</Text>
          ))}
        </Box>
      ) : null}
    </Box>
  ) as RenderElement
}

export function drawBank(els: Els, progress: OsmosisProgress, act: PaneActions): RenderElement {
  const { Box, Text, Button } = els
  const saved = Object.values(progress.saved)
  return (
    <Box flexDirection="column" gap={1}>
      <Text bold>{`Word bank (${saved.length})`}</Text>
      {saved.length === 0 ? (
        <Text dimColor>No saved words yet. Click a word in a reply, then press b to save it.</Text>
      ) : (
        <Box flexDirection="column">
          {saved.map((w, i) => (
            <Box flexDirection="row" columnGap={1}>
              <Button key={`say-${i}`} plain dimColor onPress={() => act.speak(w)}>say</Button>
              <Button key={`unsave-${i}`} plain dimColor onPress={() => act.unsave(w.target)}>unsave</Button>
              <Text>
                <Text color={LEARN_COLOR}>{w.target}</Text>
                {` ${w.romanization} `}
                <Text dimColor>{w.gloss}</Text>
              </Text>
            </Box>
          ))}
        </Box>
      )}
      <Box flexDirection="row" columnGap={2}>
        {saved.length > 0 ? <Button key="export" hotkey="e" plain onPress={act.exportAnki}>Export to Anki</Button> : null}
        <Button key="home" hotkey="h" plain onPress={act.home}>Back</Button>
        <Button key="close" hotkey="x" plain role="dismiss" onPress={act.close}>Close</Button>
      </Box>
    </Box>
  ) as RenderElement
}

export function drawQuiz(els: Els, quiz: OsmosisQuiz | null, act: PaneActions): RenderElement {
  const { Box, Text, Button } = els
  if (!quiz || quiz.questions.length === 0) {
    return (
      <Box flexDirection="column" gap={1}>
        <Text>Not enough words for a quiz yet. Read a few translated replies (or save words), then try /osmosis quiz again.</Text>
        <Box flexDirection="row" columnGap={2}>
          <Button key="home" hotkey="h" plain onPress={act.home}>Back</Button>
          <Button key="close" hotkey="x" plain role="dismiss" onPress={act.close}>Close</Button>
        </Box>
      </Box>
    ) as RenderElement
  }
  const total = quiz.questions.length
  const q = quiz.questions[quiz.index]
  if (!q) {
    return (
      <Box flexDirection="column" gap={1}>
        {quiz.feedback ? <Text dimColor>{quiz.feedback}</Text> : null}
        <Text bold>{`Score: ${quiz.score} / ${total}`}</Text>
        <Box flexDirection="row" columnGap={2}>
          <Button key="retake" hotkey="r" plain onPress={act.retake}>New quiz</Button>
          <Button key="home" hotkey="h" plain onPress={act.home}>Back</Button>
          <Button key="close" hotkey="x" plain role="dismiss" onPress={act.close}>Close</Button>
        </Box>
      </Box>
    ) as RenderElement
  }
  return (
    <Box flexDirection="column" gap={1}>
      <Text dimColor>{`Question ${quiz.index + 1} of ${total} · score ${quiz.score}`}</Text>
      <Text>
        {'Which one means '}
        <Text bold>{`"${q.gloss}"`}</Text>
        {'?'}
      </Text>
      <Box flexDirection="column">
        {q.choices.map((c, i) => (
          <Button key={`choice-${i}`} hotkey={String(i + 1)} plain onPress={() => act.answer(i)}>{c}</Button>
        ))}
      </Box>
      {quiz.feedback ? <Text dimColor>{quiz.feedback}</Text> : null}
      <Box flexDirection="row" columnGap={2}>
        <Button key="close" hotkey="x" plain role="dismiss" onPress={act.close}>Close</Button>
      </Box>
    </Box>
  ) as RenderElement
}
