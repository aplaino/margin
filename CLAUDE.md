# Margin

See what your friends are building, from one spot at the edge of your screen. This repo is a from-scratch rebuild of a prototype (archived at `~/Developer/TerminalText`).

Read before working here:
- `docs/DESIGN.md` — the source of truth for the UI: the screen-edge drawer (collapsed strip, expanded panel, chat, settings, first launch, defaults)
- `docs/PLAN.md` — phases (Step 0 and Phase 1 done; Phase 2 functionality with a two-machine test matrix), architecture, scope
- `docs/KNOWLEDGE.md` — how the prototype's messaging and compatibility layers worked, tested quirks of Claude Code / Codex / OpenCode / shell hooks, macOS notes, and mistakes not to repeat

Working rules for this project:
- One home: the screen-edge drawer. Don't add other surfaces (TUI, VS Code, menu bar, status line) without the owner.
- Work phase by phase; agree the design of anything new with the owner before building it.
- Professional and plain over feature count: no coins, casino, loot boxes, stakes or meme naming. Anything outside v1 goes to "Not in v1" first.
- Friends only ever see what you'd post publicly; privacy is enforced locally, never trusted to the server.
- Never drive the owner's screen (clicks, keystrokes into apps, screenshots, moving windows). Verify with logs, window metadata and test harnesses; ask the owner to look when visual confirmation is needed.
- Hooks must print nothing on `SessionStart`/`UserPromptSubmit` (that output enters Claude's context).
