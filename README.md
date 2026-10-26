# Osmosis 中文

![Osmosis demo: Chinese words appear in a Claude Code reply, a card floats over a hovered word, and a side pane shows the word, an example sentence, and settings](docs/demo.gif)

Osmosis is a Claude Code plugin that teaches you Mandarin while you work. It shows some English words in Claude's replies as Chinese characters, so you pick up vocabulary by osmosis while you read. The change is on your screen only. Claude never sees it, and the saved conversation does not change. Point at a Chinese word to see its meaning, or click it for a full card with pinyin, an example sentence, and a voice.

## Install

In a Claude Code terminal session:

```
/plugin install osmosis --marketplace raylrcheng/osmosis
```

Then type `y` to add the marketplace, and pick a scope.

From a shell:

```
claude plugin install osmosis --marketplace raylrcheng/osmosis
```

Requirements:

- Claude Code 2.1.275 or later.
- The fullscreen layout, for hover and click. Add `"tui": "fullscreen"` to your Claude Code settings.
  If hover and click stop working, or the pane shows above the prompt instead of at the side, Claude Code may have turned fullscreen off by itself. Type `/tui fullscreen` to turn it back on.
- Osmosis calls Claude Haiku to pick and translate words. The calls run on your own Claude login. You can use a local model instead (see below).
- macOS for the Speak button, which uses the built-in `say` command. On other systems, Speak shows a message.

## How to use it

- Read a reply as usual. A few words show in Chinese, underlined and in color.
- Point at a Chinese word. A small card shows next to the word: the characters, pinyin, word type, meaning, a character-by-character breakdown, and the HSK level. Click 🔊 on the card to hear the word. The "Hover card" setting can move this card to the bar above the prompt.
- Click a Chinese word. A side pane opens with the full card, an example sentence, and buttons. The example loads when you open the word.
- In the pane, press these keys (click the pane first):
  - `s`: say the word and the example aloud in a Chinese voice.
  - `b`: save the word to your word bank, or remove it.
  - `k`: mark the word as known. Osmosis then shows it less often.
  - `n` / `p`: go to the next or the previous word of the same reply.
  - `x`: close the pane.
- To close the pane without clicking it first, press Esc at an empty prompt, click the `×` on its frame, or type `/osmosis close`.
- The pane also lists all the Chinese words of the reply. Click one to open it.

A reply shows in English first. The Chinese words show a second or two later, when Claude has finished the reply and the translation is ready. Only the last text block of each reply is translated: short status lines between tool calls stay in English. Short replies, code, file paths, tables, and headings also stay in English.

Each word is checked against the CC-CEDICT dictionary. The dictionary sets the pinyin, the HSK level, and the character-by-character breakdown. A word the dictionary does not have is not swapped. The card shows `✓ CC-CEDICT` for a checked word.

## Settings

Type `/osmosis` to open the pane. Its Settings section has a button for each choice, so you do not need to type anything. Under each row, a short line says what the setting does. `/osmosis help` lists the same settings and lines.

- **Osmosis** (On, Off): Turn all translation on or off. Press `o` to switch.
- **Level** (Beginner, Intermediate, Advanced): Which words swap: HSK 1-2, 3-4, or 5-6. Intermediate also swaps up to 1 short phrase per block, Advanced up to 2 (with idioms).
- **Density** (Low, Normal, High): How many words swap: about 1 per 3 sentences, 1, or 2 per sentence.
- **Show** (Hanzi, Pinyin, Both): Show swapped words as characters, pinyin, or both.
- **Coverage** (Natural, Maximum): Natural keeps English grammar intact; Maximum swaps more words. Natural swaps nouns, adjectives and base-form verbs, plus a linking word that opens a sentence. Maximum gives more swaps, some read awkwardly in English word order, and allows a phrase at every level.
- **Hover card** (At the word, In the bar, Both): Where the word card appears when you point at a word. With At the word, a card with no room in its own message shows above that message. If the top of the message is off screen, the card shows in the bar instead.
- **Hover bar** (On, Off): The line above the prompt with today's count and bar cards. Press `v` to switch.
- **Status line** (On, Off): The `🌱 中文 · <level>` entry under the prompt.
- **Copy** (English, As shown): English pastes copied text in English; As shown does not.
- **Daily cap** (Off, 100k, 300k, 1M): Stop translating after this many Haiku tokens a day. The default is 300k. At the cap, replies stay in English and the bar says "daily cap reached". Local model tokens do not count.
- **Model** (Haiku, Local): Haiku (default) or a local model on your machine. See "Run it on a local model".
- **Word bank** (`w`) and **Quiz** (`q`) open those views.

The pane also shows the token count, for example `Today: 42 calls · 96k tokens (71k in / 25k out) · 7 days: 410k`. Local model tokens show on a separate line.

Settings, saved words, progress, and the token count stay between sessions.

## Commands

The same settings also work as typed commands:

| Command | What it does |
|---|---|
| `/osmosis` | Opens the pane with the words of the latest reply and the settings. |
| `/osmosis help` | Lists every setting with its values and what it does. |
| `/osmosis close` | Closes the pane. Esc at an empty prompt does the same. |
| `/osmosis on` / `/osmosis off` | Turns Osmosis on or off. Off shows all replies in plain English. |
| `/osmosis level beginner` | Sets the level: `beginner`, `intermediate`, or `advanced`. |
| `/osmosis density normal` | Sets the density: `low`, `normal`, or `high`. |
| `/osmosis show hanzi` | Sets how a word shows: `hanzi`, `pinyin`, or `both`. |
| `/osmosis coverage natural` | Sets the coverage: `natural` keeps English grammar intact; `maximum` gives more swaps, some read awkwardly in English word order. |
| `/osmosis card word` | Sets where the hover card shows: `word` (next to the word), `bar` (in the bar above the prompt), or `both`. |
| `/osmosis band on` / `/osmosis band off` | Shows or hides the hover bar above the prompt. |
| `/osmosis status on` / `/osmosis status off` | Shows or hides the Osmosis entry in the status line. |
| `/osmosis copy english` / `/osmosis copy shown` | Sets what a copied selection pastes as: the English original, or the text as shown. |
| `/osmosis cap 300k` | Sets the daily cap: `off`, `100k`, `300k`, or `1m` Haiku tokens. |
| `/osmosis model haiku` | Sets the model: `haiku` or `local`. |
| `/osmosis endpoint <url>` | Sets the local server address. The default is `http://127.0.0.1:8080/v1`. |
| `/osmosis local-model <name>` | Sets the model name sent to the local server. Ollama and LM Studio need it. |
| `/osmosis debug on` / `/osmosis debug off` | Writes a short trace (keys and counts, never reply text) to `~/.claude/plugins/data/osmosis/debug.log`, to help find a problem. |
| `/osmosis bank` | Opens your word bank. Each word has "say" and "unsave" buttons. |
| `/osmosis export` | Saves your new saved words as an Anki deck in Downloads. `/osmosis export all` saves every saved word. See "Export to Anki". |
| `/osmosis quiz` | Starts a 5-question quiz from your saved and recent words. Press `1`-`4` to answer. A word you get right 3 times becomes "known". |
| `/osmosis lang <name>` | Sets the language. Mandarin is the default and the tested language. |

The status line shows `🌱 中文 · <level>` while Osmosis is on, unless you turn it off.

## Good to know

- Osmosis splits each finished reply into chunks of about 4 sentences and sends them to Claude Haiku 5.5 at low effort, all at once. The first words show in about 1-2 seconds. Each chunk's words show as soon as that chunk is done.
- A long reply costs about 115 Haiku tokens per sentence. Opening a word for its example costs one more small call, once per word. Osmosis remembers old translations and examples, so they show again at once.
- If a translation fails, the reply shows in plain English.
- Osmosis translates only your own replies. A subagent's messages stay in English. A Claude session that another Claude session started, such as an agent's worker, runs with Osmosis off.
- On macOS and Linux, text you copy from a translated reply pastes as English. Osmosis watches the clipboard (with `pbpaste`, `wl-paste` or `xclip`) only to revert its own swaps, and only while a translated reply is on screen; it changes nothing else and keeps no copy of what you copied. A copy that spans two replies stays as shown.
- A typed command prints one short line, for example "Osmosis level: beginner." Claude sees that line, as it sees any command output. The pane buttons print nothing.

## Run it on a local model

Osmosis can use a model on your own computer instead of Claude Haiku. It sends requests to any server with an OpenAI-compatible chat completions API. Nothing goes to Claude for translation then, and the daily cap does not apply.

1. Install [llama.cpp](https://github.com/ggml-org/llama.cpp), then start its server with a small instruct model. This example downloads Qwen3 4B Instruct (about 2.5 GB) on first run:

   ```
   llama-server -hf unsloth/Qwen3-4B-Instruct-2507-GGUF:Q4_K_M --port 8080
   ```

2. In Claude Code, type:

   ```
   /osmosis model local
   ```

Other servers work too:

- Ollama: `/osmosis endpoint http://127.0.0.1:11434/v1`, then `/osmosis local-model <model name>`.
- LM Studio: `/osmosis endpoint http://127.0.0.1:1234/v1`, then `/osmosis local-model <model name>`.

Osmosis asks the server for JSON that matches a schema. If the server refuses the schema, Osmosis asks again without it and checks the reply the same way. If the server does not answer, the reply stays in English and the bar says "local model unreachable". Osmosis never switches to Haiku by itself. The CC-CEDICT check runs on local results too, so it fixes most pinyin and HSK mistakes of a small model.

## Export to Anki

Type `/osmosis export`, or press `e` in the word bank. Osmosis saves your saved Mandarin words as an Anki deck file, for example `~/Downloads/osmosis-2026-10-21.apkg`. Open the file to import it into Anki.

- Each word makes up to three cards. Recognition shows the word, Production shows the meaning, and Listening plays the word. The back has the word, the pinyin in tone colors, the meaning, the example sentence, and the audio.
- The audio comes from Microsoft's online Edge voice (`zh-CN-XiaoxiaoNeural`), so the words and examples you export are sent to Microsoft. The first export installs `edge-tts` into the plugin's data folder (`~/.claude/plugins/data/osmosis`). If the voice is not available, for example offline, the deck is still saved; the cards then use Anki's own voice, and there is no Listening card.
- The cards go in an "Osmosis" deck, with the tag `osmosis`.
- An export holds only the words you saved since the last export. `/osmosis export all` exports every saved word again. A word you import twice updates its card; it does not make a copy.
- The file holds only the card text. No settings or other data go in it.
- It needs Anki 25.x on the same computer. Osmosis builds the deck with the Python that comes with Anki, in a temporary folder. It never opens your own Anki collection, so Anki can stay open.

## Credits

- [CC-CEDICT](https://www.mdbg.net/chinese/dictionary?page=cc-cedict), by the CC-CEDICT contributors, published by MDBG under the [Creative Commons Attribution-ShareAlike 4.0 International License](https://creativecommons.org/licenses/by-sa/4.0/). It gives the pinyin, the short meanings, and the character breakdown. Osmosis ships an adapted copy of the 2026-10-14 release: the pinyin is converted to tone marks, and each reading keeps one short meaning. The adapted copy is shared under the same license.
- The HSK 2.0 word lists (levels 1-6) from [complete-hsk-vocabulary](https://github.com/drkameleon/complete-hsk-vocabulary) by Yanis Zafirópulos, under the MIT License. They give the HSK levels.

The files in `data/` come from these sources and stay under their licenses. `scripts/build-dict.mjs` rebuilds `data/` from them: run `node scripts/build-dict.mjs`.

## License

The code is MIT. See [LICENSE](LICENSE). The files in `data/` are under the licenses in [data/README.md](data/README.md).
