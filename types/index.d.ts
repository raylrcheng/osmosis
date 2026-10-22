export type OsmosisLevel = 'beginner' | 'intermediate' | 'advanced'
export type OsmosisDensity = 'low' | 'normal' | 'high'
// Any mix of hanzi, pinyin and english joined by '+' (hanzi or pinyin always one of them); 'both' is hanzi+pinyin.
export type OsmosisShow = string
export type OsmosisCard = 'word' | 'bar' | 'both'
export type OsmosisCap = 'off' | '100k' | '300k' | '1m'
export type OsmosisProvider = 'haiku' | 'local'

export type OsmosisSettings = {
  isOn: boolean
  level: OsmosisLevel
  density: OsmosisDensity
  show: OsmosisShow
  isBandOn: boolean
  isStatusOn: boolean
  isFocusOn: boolean
  copy: 'english' | 'shown'
  debug: boolean
  coverage: 'natural' | 'maximum'
  card: OsmosisCard
  cap: OsmosisCap
  model: OsmosisProvider
  endpoint: string
  localModel: string
  lang: string
}

export type OsmosisWord = {
  en: string
  occurrence: number
  target: string
  romanization: string
  pos: string
  gloss: string
  literal: string
  exampleTarget: string
  exampleRomanization: string
  exampleEn: string
  level: number | null
  start: number
  end: number
  verified?: boolean
  kind?: 'word' | 'phrase'
  dictGloss?: string
}

export type OsmosisTx =
  | { status: 'ok'; words: OsmosisWord[] }
  | { status: 'failed'; reason: string }

export type OsmosisExample =
  | { status: 'ok'; target: string; romanization: string; en: string }
  | { status: 'failed' }

export type OsmosisTally = { calls: number; input: number; output: number; cacheRead: number; cacheWrite: number }

export type OsmosisUsage = { days: Record<string, Partial<Record<OsmosisProvider, OsmosisTally>>> }

export type OsmosisHealth = { local: 'ok' | 'down' | 'unknown' }

export type OsmosisRecentWord = { key: string; index: number; word: OsmosisWord }

export type OsmosisSelection = { key: string; index: number }

export type OsmosisView = 'home' | 'bank' | 'quiz'

export type OsmosisQuestion = {
  target: string
  romanization: string
  gloss: string
  choices: string[]
  answer: number
}

export type OsmosisQuiz = {
  questions: OsmosisQuestion[]
  index: number
  score: number
  feedback: string
}

export type OsmosisSeen = {
  n: number
  en: string
  gloss: string
  romanization: string
  last: number
}

export type OsmosisProgress = {
  seen: Record<string, OsmosisSeen>
  known: Record<string, true>
  saved: Record<string, OsmosisWord>
  mastery: Record<string, number>
  today: { date: string; count: number }
  exported: Record<string, string>
}

declare module 'claude-code' {
  interface PluginState {
    osmosis: {
      settings: OsmosisSettings
      tx: StateFamily<OsmosisTx>
      recent: OsmosisRecentWord[]
      latest: string | null
      selected: OsmosisSelection | null
      view: OsmosisView
      quiz: OsmosisQuiz | null
      progress: OsmosisProgress
      finals: string[]
      usage: OsmosisUsage
      ex: StateFamily<OsmosisExample>
      health: OsmosisHealth
      fallbacks: string[]
      help: string | null
    }
  }
}
