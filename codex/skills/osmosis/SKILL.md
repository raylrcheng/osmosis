---
name: osmosis
description: Change Osmosis settings (the Mandarin vocab card under each reply). Use only when the user types $osmosis or asks to change Osmosis.
---

Run `node scripts/settings.mjs <args>` from the folder of this SKILL.md (use the absolute path) and show its output as is.

- No args: current settings, today's usage, the last run.
- `on` | `off`, `level beginner|intermediate|advanced`, `density low|normal|high`
- `model gpt-6-luna|<Codex model>|local`, `endpoint <url>`, `local-model <name>`, `cap off|100k|300k|1m`, `help`

The script writes outside the workspace; if the sandbox blocks it, ask to run it with escalated permissions.
