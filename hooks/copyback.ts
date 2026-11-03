import type { OsmosisSettings, OsmosisWord } from '../types'
import { planMessage, shownFull } from './core'

export type ShownBlock = { text: string; words: readonly OsmosisWord[] }

type Span = { start: number; end: number; en: string }
type Shown = { text: string; swaps: Span[] }

export function displayed(block: ShownBlock, show: OsmosisSettings['show']): Shown {
  let out = ''
  const swaps: Span[] = []
  planMessage(block.text, block.words).forEach((seg, si) => {
    if (si > 0) out += '\n'
    if (seg.kind === 'md') {
      out += seg.text
      return
    }
    for (const line of seg.lines) {
      if (line.marker !== null) out += `${line.marker} `
      for (const t of line.tokens) {
        if (t.kind === 'parts') {
          out += t.parts.map(p => p.text).join('')
          continue
        }
        const w = block.words[t.index]!
        const text = shownFull(w, show)
        swaps.push({ start: out.length, end: out.length + text.length, en: w.en })
        out += text + t.trailing
      }
      out += '\n'
    }
  })
  return { text: out, swaps }
}

type Normal = { text: string; map: number[] }

const DROP = new Set(['*', '`', '⏺'])

export function normalize(s: string): Normal {
  let text = ''
  const map: number[] = []
  for (let i = 0; i < s.length; i++) {
    const ch = s[i]!
    if (DROP.has(ch)) continue
    if (/\s/.test(ch)) {
      if (text.length > 0 && !text.endsWith(' ')) {
        text += ' '
        map.push(i)
      }
      continue
    }
    text += ch
    map.push(i)
  }
  if (text.endsWith(' ')) {
    text = text.slice(0, -1)
    map.pop()
  }
  return { text, map }
}

function firstAtOrAfter(map: readonly number[], pos: number): number {
  let i = 0
  while (i < map.length && map[i]! < pos) i++
  return i
}

// Returns the clipboard text with Osmosis's own swaps put back in English, or null to leave it alone.
export function revertCopy(clip: string, blocks: readonly ShownBlock[], show: OsmosisSettings['show']): string | null {
  const c = normalize(clip)
  if (c.text.length < 2) return null
  for (const block of blocks) {
    const d = displayed(block, show)
    const dn = normalize(d.text)
    const p = dn.text.indexOf(c.text)
    if (p < 0) continue
    const end = p + c.text.length
    const edits: { from: number; to: number; en: string }[] = []
    for (const s of d.swaps) {
      const ns = firstAtOrAfter(dn.map, s.start)
      const ne = firstAtOrAfter(dn.map, s.end)
      if (ne <= p || ns >= end) continue
      const cs = Math.max(ns, p) - p
      const ce = Math.min(ne, end) - p
      if (ce <= cs) continue
      edits.push({ from: c.map[cs]!, to: c.map[ce - 1]! + 1, en: s.en })
    }
    if (edits.length === 0) return null
    let out = clip
    for (const e of edits.sort((a, b) => b.from - a.from)) out = out.slice(0, e.from) + e.en + out.slice(e.to)
    return out
  }
  return null
}
