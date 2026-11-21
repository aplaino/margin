# Margin — rebuild plan

Agreed 2026-11-21. Replaces the prototype, archived at `~/Developer/TerminalText` (commits `f9b0121`, `15b36b7`). What we learned building it is in [KNOWLEDGE.md](KNOWLEDGE.md); the agreed UI is in [DESIGN.md](DESIGN.md). This plan reuses those findings but none of the prototype code by default.

The rebuild runs in **phases**. Each phase ends with a review, and the next starts only when the owner agrees.

## 1. Product

**One line:** see what your friends are building, from one spot at the edge of your screen.

**For:** developers who work in terminals and AI coding tools (Claude Code, Codex, OpenCode), on macOS first.

**Core loop:**
1. You work as usual. Margin's strip at the screen edge shows which friends are coding.
2. Open it to see what they're working on, chat, or add friends.
3. Your all-time token total sits in your header and on your row for friends (replaces XP).

**v1 includes**
- One home: the **screen-edge drawer** described in DESIGN.md (collapsed strip of dots + unread; expanded Friends / Add / Settings; chat inside the drawer; first-launch flow).
- Sign in with GitHub; invite-only friends (requests, accept, decline, remove, block, report).
- Live presence from Claude Code, Codex, OpenCode and the shell, with privacy controls (invisible, per-field, close friends, per-repo overrides).
- End-to-end encrypted 1:1 chat with offline delivery and safety-number verification.
- Connecting tools from the drawer's settings (installs/removes hooks with consent and backups); account export and deletion; privacy policy.
- Token totals (input + output + cache writes, all connected tools) in the header and on every friend; theme setting (System/Light/Dark + accent). No XP or levels.

**Not in v1:** VS Code/Cursor, a TUI, the Claude Code status line, a menu bar icon, other surfaces; duels and goals, stuck/help requests, cosmetics, group chat, multi-device, Linux/Windows apps, tmux pane, terminal-native notifications, git push hook.

## 2. Principles

- One home on screen: the drawer. No other surface without the owner's agreement.
- Friends only ever see what you'd post publicly. Privacy is enforced locally, never trusted to the server.
- Plain and fast first; style after the behaviour feels right.
- Agree the design of a feature before building it; every phase ends with tests, docs and a demo.

## 3. Architecture

```
reporters (Claude Code + Codex hooks, OpenCode plugin, shell) ─▶ margind ─▶ api server ─▶ friend's margind ─▶ friend's drawer
                                                                   ▲
                                              Margin.app (drawer) ─┘ local socket
```

- **Margin.app** — the drawer (Swift/SwiftUI, Xcode project). The only UI.
- **`margind`** — background service: sessions, redaction, encrypted local store, Signal sessions, outbox, settings. The only thing that talks to the server. A separate Bun process (decided at Phase 2 kickoff), reusing KNOWLEDGE.md's findings and libsignal JS.
- **`api`** — Bun HTTP + WebSocket service: auth, friend graph, key directory, presence fan-out (memory), ciphertext queue. Postgres.
- **Protocols** — local (app/reporters ↔ margind) and server (margind ↔ api), versioned and validated against shared schemas at every boundary.

### Tech choices
- TypeScript on Bun 1.3.x for margind and api; **Biome** for lint + format; strict tsconfig; **Valibot** schemas shared by every TypeScript component.
- Postgres 17 (Neon) with versioned migrations; SQLite + AES-GCM locally, key in the Keychain.
- `libsignal` for X3DH + Double Ratchet.
- Margin.app in Swift/SwiftUI with Xcode (proper SwiftUI, signing, notarization, auto-update).

## 4. Phases

### Step 0 — Clean machine ✓ (2026-11-21)
Prototype servers stopped; its hooks, links and status-line lines removed with backups; data and Postgres volume kept for reference.

### Phase 1 — Design ✓ (2026-11-21)
Where Margin lives and how it behaves: [DESIGN.md](DESIGN.md), with a visual mockup at https://claude.ai/artifact/EFDoG2nu21M53kM8xAhuYr. Signed off by the owner on 2026-11-21, on condition that themes changing fonts and colours come after Phase 2.

### Phase 2 — Functionality
Build the core against DESIGN.md and prove it **between two different users on two different machines**, each with their own margind, through a staging server that runs on neither machine (Fly.io + Neon).

Kickoff decisions (2026-11-21):
- **margind is a separate Bun process**; Margin.app is a thin Swift UI over a local socket.
- **Second machine:** a friend of the owner's has offered their Mac for the two-machine tests (a macOS VM on this Mac is the fallback).
- **Xcode** is installed by the owner in parallel; everything up to step 6 doesn't need it.

Build order:
1. ✓ Bootstrap: Bun workspaces (`packages/protocol`, `apps/api`, `apps/margind`), Biome, strict tsconfig, CI.
2. ✓ Protocol: Valibot schemas for server and local messages, with the protocol version.
3. ✓ api: GitHub device sign-in, friends, key directory, presence fan-out, ciphertext queue; Postgres + SQLite.
4. ✓ margind: encrypted store, Signal sessions, transport, tool hooks, token totals, redaction.
5. ✓ Two-daemon end-to-end tests on one machine (`apps/margind/test/e2e.test.ts`).
6. Margin.app: the drawer, built against the mockup (`apps/mac`, a Swift package; `bun run dev` runs it locally with simulated friends).
7. Server on Fly.io + Neon (live at https://margin-api.fly.dev), real GitHub sign-in, self-contained Margin.app with automatic updates (Sparkle, served by the server); run the matrix between this Mac and the friend's Mac; record in `docs/TESTING.md`.

Scope: sign-in, friends, presence from each v1 tool, token totals, privacy settings, chat, the drawer (collapsed, expanded, chat, Add, Settings incl. five themes with light and dark plus accent, first launch, connecting tools). Every colour, font, size and shape comes from one theme definition.

Test matrix — each row run on both machines, in both directions:

| Area | Must pass |
|---|---|
| Sign-in | GitHub sign-in from the drawer; sign out and back in |
| Friends | Request, accept, decline, remove; mutual request auto-accepts; block makes the blocker indistinguishable from an unknown handle |
| Presence | Claude Code, Codex, OpenCode and shell activity show up on the other machine within 5 s; sessions end when the tool exits or goes idle |
| Privacy | Invisible, hidden fields, close friends and repo overrides take effect on the other machine |
| Chat | Both directions; delivered after the receiver was offline; history survives app and daemon restarts; forged sender rejected |
| Tokens | Each machine's total matches its tools' own usage records; the friend sees the same number within 5 s; hidden when the tokens field is off |
| Drawer | Collapsed dots and unread match reality; every expand trigger works and can be switched off; never steals focus unless typing |
| Tools | Connecting/disconnecting each tool from Settings installs/removes only Margin's hook, with a backup |
| Versions | An older app gets an "Update Margin" state, not a crash |
| Leaks | No path, branch, file name, prompt or private repo name leaves either machine (leak harness + server inspection) |

Results are recorded in `docs/TESTING.md`. **Done when** every row passes.

### Review
What worked, what felt wrong, and what comes next, then production (signed app, Homebrew, monitoring, backups) and a private beta.

## 5. Engineering practices

- `main` is always releasable; short-lived branches with PRs; squash merges with "why"-focused messages; commits authored as `183426759+aplaino@users.noreply.github.com`.
- Tests: unit per package; daemon ↔ api integration on SQLite in memory and Postgres; end-to-end with two daemons; two-machine runs for Phase 2. The drawer's look and feel is checked by the owner (no screen automation).
- Every external input validated (protocol schemas, handles, text scrubbing, server values used in paths); security review at the end of Phase 2.
- Semantic versioning for the app and margind; protocol version bumped on breaking changes.

## 6. Hosting and distribution

- **Fly.io** (api) + **Neon** (Postgres) — decided.
- Signed, notarized direct download + Homebrew; not the Mac App Store (Margin installs hooks into other tools' config files).
- Apple Developer Program before the beta (ad-hoc signed builds until then).
- **Open:** domain (`margin.dev`, `getmargin.app`, `usemargin.dev` — check availability).

## 7. Risks

| Risk | Mitigation |
|---|---|
| Tool hook payloads change between versions | Version-pinned adapters with payload fixtures in tests; degrade to tool-only presence |
| The drawer collides with the Dock, hot corners or window edges | Edge and vertical position settings; Dock-aware default; click-through outside the strip (DESIGN.md §2–3) |
| Presence metadata visible to the server | Documented; minimal fields; memory only |
| Scope creep | v1 list is fixed; everything else goes through "Not in v1" and the owner |
