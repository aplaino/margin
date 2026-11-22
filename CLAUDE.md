# Margin

See what your friends are building, from one spot at the edge of your screen. This repo is a from-scratch rebuild of a prototype (archived at `~/Developer/TerminalText`).

Read before working here:
- `docs/DESIGN.md` — the source of truth for the UI: the screen-edge drawer (collapsed strip, expanded panel, chat, settings, first launch, defaults)
- `docs/PLAN.md` — phases (Step 0 and Phase 1 done; Phase 2 functionality with a two-machine test matrix), architecture, scope
- `docs/KNOWLEDGE.md` — how the prototype's messaging and compatibility layers worked, tested quirks of Claude Code / Codex / OpenCode / shell hooks, macOS notes, and mistakes not to repeat

Working rules for this project:
- One home: the drawer, at a screen edge or under its menu bar item (Settings → Position). Don't add other surfaces (TUI, VS Code, status line) without the owner.
- Work phase by phase; agree the design of anything new with the owner before building it.
- Professional and plain over feature count: no coins, casino, loot boxes, stakes or meme naming. Anything outside v1 goes to "Not in v1" first.
- Friends only ever see what you'd post publicly; privacy is enforced locally, never trusted to the server.
- Never drive the owner's screen (clicks, keystrokes into apps, screenshots, moving windows). Verify with logs, window metadata and test harnesses; ask the owner to look when visual confirmation is needed.
- Hooks must print nothing on `SessionStart`/`UserPromptSubmit` (that output enters Claude's context).

Running it locally: `bun run dev` starts the server (dev sign-in) on 127.0.0.1:8787, the owner's margind (real data folder and token count), simulated friends, and opens Margin.app. Server and simulated friends keep their data in `.dev/`. To start over, delete `.dev/` and `~/Library/Application Support/Margin` together (keeping one without the other makes sign-in fail: the server already has a different identity key for the account). `bun run app` only builds `apps/mac/build/Margin.app`.

Releasing: `bun run release` (clean, committed tree) builds Margin.app for https://margin-api.fly.dev, signs the zip with the Sparkle EdDSA key in this Mac's Keychain (account `margin`), and uploads it with the release token (Keychain service `margin-release`). Installed copies update themselves at launch and hourly. First installs: https://margin-api.fly.dev/download. Losing the Sparkle key means installed copies can no longer be updated: keep a backup (`apps/mac/.build/artifacts/sparkle/Sparkle/bin/generate_keys --account margin -x <file>`, stored somewhere safe, never in the repo).

Server: Fly.io app `margin-api` (one machine in `ord` with the `margin_data` volume for release zips), Neon Postgres in us-east-2 (`DATABASE_URL` is a Fly secret). Deploy with `fly deploy --ha=false`.
