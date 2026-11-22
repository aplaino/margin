# Margin (formerly TerminalText): what we learned building the prototype

Written 2026-11-21, before restarting the project from scratch. This captures how the messaging layer and the compatibility layer (hooks, editors, terminals, macOS) work, every tool quirk we found by testing against real installs, and the mistakes worth not repeating. The prototype code lives in `~/Developer/TerminalText` (git, first commit `63c8fa9`); paths below refer to it.

---

## 1. Architecture that worked

```
reporters (hooks, plugin, extension, shell) ─▶ friendd (local daemon) ─▶ server ─▶ friends' friendd ─▶ surfaces
             whitelist fields at the edge        redaction + encryption     relay only (ciphertext,        TUI, VS Code, menu bar,
                                                  + local encrypted DB       live presence)                 status line, margin
```

- **friendd** (one per user per machine) owns everything sensitive: sessions, keys, message history, settings. Every surface talks to it over a Unix socket (`~/.margin/profiles/<profile>/friendd.sock`) with newline-delimited JSON: requests `{op: ...}`, pushes `{type: ...}`, and `{type: "result", op, ok, data|error}` replies. Surfaces stay dumb and interchangeable.
- **Privacy is enforced in friendd, before anything leaves the machine**, never trusted to the server or surfaces.
- **The server is a relay**: auth, friend graph, public key directory, live presence fan-out (memory only), ciphertext queue, game state. It never sees message plaintext.
- **Same SQL on Postgres and SQLite** (`Bun.SQL`), so the server suite runs in memory in tests and on Postgres in Docker/CI.
- **Profiles** (`--as <handle>`, `MARGIN_PROFILE`) let several simulated users run on one machine; a loopback transport delivered between local daemons before the server existed. Very useful for development.

## 2. Messaging layer (E2E chat)

Library: `libsignal` 6.0.0 (npm, the JS port: X3DH + Double Ratchet). Code: `src/signal.ts`, `src/store.ts`, `src/transport.ts`, `server/app.ts`.

### Keys and sessions
- Identity key pair, registration id, one signed prekey (id 1), and one-time prekeys generated on first run; private parts stored encrypted in the local DB (`kv` key `signal:self`, `prekeys` table).
- **Bundle** = `{handle, registrationId, identityKey, signedPreKey{keyId, publicKey, signature}, preKeys[]}`, base64. Published with `PUT /keys`; the server refuses to change an account's identity key (409) — identity is account-level until device linking exists.
- **Sending**: if there's no open session, `SessionBuilder.initOutgoing(bundle)` with one random prekey from the fetched bundle, then `SessionCipher.encrypt`. Ciphertext `{type, body}`; `type === 3` is a PreKeyWhisperMessage (first message), receiver uses `decryptPreKeyWhisperMessage`, else `decryptWhisperMessage`.
- **Sessions** are stored as JSON of `record.serialize()` (it returns a plain object, not bytes — serialize to JSON yourself).

### Trust and identity pinning
- **Identity keys are pinned at friend-add time** (from the friend's bundle) and the store's `isTrustedIdentity` compares against the pin. A forged sender with another identity key throws `UntrustedIdentityKeyError` (tested).
- Gotcha: `isTrustedIdentity` receives addresses as `"<name>.<deviceId>"` (e.g. `alice.1`). Strip the `.N` suffix before looking up the pin.
- **Both sides must pin each other** before a session works (tests failed until both had pins).
- **Safety numbers**: sha256 of the two identity keys sorted, first 20 hex chars in groups of 5. Shown after `friend accept`; there's no verification UI yet (needed for launch).

### Prekeys
- 50 one-time prekeys at creation. The server **pops** one per `GET /keys/:handle` (`DELETE ... RETURNING`), only for friends (so strangers can't drain them).
- **Top-up**: `GET /keys/count`; when fewer than 20 remain, friendd generates more with ids above the highest ever used (track a `signal:maxPreKey` counter, since used ids are deleted locally) and `POST /keys/prekeys` (server caps at 200). Tested by starting a real session with a replenished key.

### Transport and delivery
- One authenticated WebSocket per daemon (`Authorization: Bearer`), exponential backoff 1 s → 30 s, `stop()` for good on sign-out.
- **The server sets `from` on everything it relays** from the authenticated session — never trust a client-supplied sender.
- Messages are queued as ciphertext (`queued_messages`), pushed if the friend is online, **deleted only on ack**, and expire after 30 days. friendd **acks only after decrypt + store**, so a crash can't lose a message. Undelivered sends go to a local encrypted `outbox` and flush on reconnect.
- **Per-socket ordering**: the server must process each socket's messages strictly in order (promise chain per socket). Found on Postgres: a "targeted" presence was overtaken by the default one that followed it because handlers awaited DB calls concurrently.
- **Blocks are unobservable**: blocked and unknown handles get the identical 404.

### Local storage
- SQLite (`bun:sqlite`) with **AES-256-GCM on every sensitive column** (keys, sessions, message bodies, outbox, settings, cached profiles). The 32-byte DB key lives in the macOS Keychain (`security add/find-generic-password`, service `margin`, account `db:<profile>@<data root>`) or libsecret (`secret-tool`) on Linux — never next to the DB.
- Renaming the data folder or keychain service orphans the key: copy the secret to the new account, verify the daemon opens the DB, then delete the old one (done for the TerminalText → Margin rename).
- Tests that create stores must clean up their keychain items, or they leak entries.

### Presence (not E2E, by design)
- Presence goes to the server in clear (status + allowed activity fields) so it can fan out; metadata exposure is documented.
- **Targeted views** (close friends see activity, others see only online/idle): the client sends the full view with `to: [handles]` first, then the basic view; the server keeps a per-viewer override map and replays the right view on reconnect.
- Heartbeat every 30 s; a friend is stale after 90 s; offline broadcast on SIGTERM.

## 3. Compatibility layer: getting activity out of tools

Rule: **whitelist fields at the reporter**, so raw payloads (prompts, replies, branch names) never reach friendd. The hook reporter (`src/reporters/hook.ts`) keeps only `{tool, event, sessionId, model?, cwd?, pid?}`, is silent on stdout, and always exits 0 with a short socket timeout.

### Claude Code (tested on 2.1.311)
- Events used: `SessionStart`, `UserPromptSubmit`, `Stop`, `SessionEnd`, `PostModelSwitch`, registered in `~/.claude/settings.json` → `hooks[Event] = [{hooks: [{type: "command", command, timeout: 5}]}]`. Add yours alongside other tools' hooks; never replace the array.
- `SessionStart` has `model`, `source`, `cwd`, `session_id`. `PostModelSwitch` has `from_model`/`to_model`. `Stop` has no model but has `last_assistant_message` (drop it). `UserPromptSubmit` has the full `prompt` (drop it).
- `SessionEnd` fires on `/exit` (`reason: prompt_input_exit`) and SIGTERM (`reason: other`). Hook config changes apply to running sessions (hot reload).
- **Liveness**: walk up from the hook's parent PID to the `claude` process and watch it; a session ends when that PID dies even without `SessionEnd`.
- **stdout matters**: whatever a `SessionStart` or `UserPromptSubmit` hook prints is added to the model's context. Print nothing there (measured: 0 bytes, ~20 ms per hook).
- **`Stop` hook `{"systemMessage": "..."}`** is documented as shown to the user in the session, not given to the model (not verified beyond the docs). Because it carries text friends wrote, the rebuild defaults to **metadata only** ("2 new messages from Maya", validated handles/display names, no message bodies) and treats previews as an opt-in setting, enabled only after confirming the field never reaches the model. Used for "friends' notices since last turn" (friendd keeps a per-session cursor, last 50 notices in memory, a new session gets the last 5 minutes). Label and sanitize it anyway.
- **Status line**: `statusLine.command` receives session JSON on stdin and prints one line (ANSI allowed). Ours answers in ~30 ms and prints nothing if friendd doesn't reply in 400 ms. If another tool owns `statusLine.command` with a script that has a "custom output" section (Vibe Island does), append a line to that script rather than replacing the command.
- `/model` persists the choice as the user's default model — restore it after testing.

### Codex CLI (tested on 0.171.0)
- Hooks in `~/.codex/hooks.json` (same shape as Claude's). **Every event carries `model`**, so switches show up on the next event (no dedicated switch event).
- `SessionStart` fires lazily on the first prompt, not at launch. `UserPromptSubmit` has `prompt`, `Stop` has `last_assistant_message` (drop both).
- `SessionEnd` doesn't fire on `/exit`; it fires for the previous session when the next `codex` starts. Unusable for presence.
- Hooks run inside Codex's **long-lived app-server**, so the hook's parent PID says nothing about the session: expire Codex sessions after 15 minutes of inactivity instead.
- **New hooks need per-hook trust** in Codex's `/hooks` review screen (stored under `[hooks.state]` in `~/.codex/config.toml`). Don't interact with that screen on someone's behalf: typing into it once trusted 23 unrelated hooks and had to be reverted by diffing the TOML.
- `/model` persists to `config.toml`.

### OpenCode (tested on 2.2.7)
- v2 plugin format: `export default { id, setup: async (ctx) => {...} }`, events via `for await (const e of ctx.event.subscribe())`. (v1 plugins — a default-exported function — fail to load.) Install by symlinking into `~/.config/opencode/plugins/`.
- Plugins run in OpenCode's background service. `session.created` can fire before your subscription starts, so look up the directory with `ctx.session.get({sessionID})` → `location.directory` on the first step.
- `session.step.started` carries `model: {providerID, id}` every step (per-turn model). `session.inbox.enqueued` carries prompt text (count it, never forward it). `session.archived`/`session.deleted` end a session. `vcs.branch.updated` carries the branch name (drop).
- The HTTP/SSE API exists (`/api/event`, basic auth `opencode:<generated password>`), but discovering and authenticating to the background service is awkward — the plugin is the better path.

### VS Code (tested on 1.146)
- In a trusted workspace the built-in Git API (`vscode.git` → `getAPI(1)`) gives remotes immediately. **In Restricted Mode (any untrusted folder) `vscode.git` is hidden entirely**, and `extensionDependencies` on it blocks your extension from activating. Declare `untrustedWorkspaces: "limited"` and let friendd parse `.git/config` as text.
- Presence from focus/edit/save events, throttled to 60 s; expire after 15 minutes idle. VS Code has no API for the active AI model.
- The extension is symlinked into `~/.vscode/extensions/<publisher>.<name>`; Cursor/Windsurf use `~/.cursor/extensions`, `~/.windsurf/extensions`. Changing the extension id changes view ids and requires a window reload.
- **Embedding the TUI**: a webview with xterm.js (`@xterm/xterm` 5.5 + `@xterm/addon-fit`, loaded from the extension folder via `asWebviewUri`, CSP `script-src ${cspSource} 'nonce-…'`) running `margin tui --embedded` over pipes. Embedded mode skips raw mode and takes size from env + an in-band resize sequence (`ESC ] margin-resize;<cols>;<rows> BEL`). One UI codebase for terminal and editor.

### Tools that copied Claude Code's hooks (checked 2026-11-21)
Qwen Code 0.28.3, CodeBuddy 2.185.0, Qoder 1.1.95 and Factory Droid 1.17.1 take Claude Code's hook commands and payloads (`hook_event_name`, `session_id`, `cwd`, JSON on stdin) with `SessionStart`, `UserPromptSubmit`, `Stop`, `SessionEnd`. None asks you to approve user-level hooks (only project hooks).
- **Where**: `~/.qwen/settings.json`, `~/.codebuddy/settings.json`, `~/.qoder/settings.json` under `hooks`; Factory reads `~/.factory/hooks.json` with the **events at the top level** (no `hooks` key), and an event there replaces the same event in `~/.factory/settings.json`, so write `hooks.json`. Droid reloads hooks when the file changes; the others need a restart.
- **Seen firing without signing in** (a stand-in `margind` on PATH logging stdin): Qwen `SessionStart`; CodeBuddy `SessionStart`, `UserPromptSubmit`, `Stop`; Factory `SessionStart`, `SessionEnd`. Qoder asks for login before any hook runs.
- Qwen's `SessionStart` carries `model`; CodeBuddy's `SessionStart` has **no `cwd`** (its later events do). Qwen reads command-hook `timeout` in seconds, but a value of 1000 or more as milliseconds (older configs).

### Gemini CLI (0.70.0)
- Hooks in `~/.gemini/settings.json` under `hooks`, on by default, no approval for user hooks (project hooks are fingerprinted). Events: `SessionStart`, `BeforeAgent` (a prompt), `AfterAgent` (end of a turn), `SessionEnd`. Base payload has `session_id`, `cwd`, `hook_event_name`; no model.
- **`timeout` is in milliseconds** (default 60000). Claude Code's `timeout: 5` would kill the hook after 5 ms.
- stdout must be empty or JSON. Asks for auth before running any hook, so live payloads need a signed-in account. `~/.gemini` is shared with Antigravity's config.

### Cursor (cursor-agent 2026.11.19)
- `~/.cursor/hooks.json`: `{"version": 1, "hooks": {"<event>": [{"command": "...", "timeout": 5}]}}` — commands listed directly, no groups. Applies to the IDE's agent and `cursor-agent`, not cloud agents.
- Events: `sessionStart`, `beforeSubmitPrompt`, `stop`, `sessionEnd`. The session is `conversation_id` (`session_id` only on session events), the folder is `workspace_roots[0]`, and every payload carries `model` and **`user_email`** (drop it).
- `cursor-agent` asks for login before hooks run. Install with `brew install --cask cursor-cli`.

### Kimi Code (2.7.2)
- The Python `kimi-cli` (`~/.kimi`) is unmaintained and says so; Kimi Code is the npm package `@moonshot-ai/kimi-code` (also `kimi`), with config in `~/.kimi-code/config.toml` (or `$KIMI_CODE_HOME`).
- Hooks are `[[hooks]]` tables with exactly `event`, `command`, optional `matcher`, `timeout` (seconds, 1–600) — a strict schema, so an extra key breaks the config. Payload: `hook_event_name`, `session_id`, `cwd`.
- Margin cuts its own tables out by header and appends new ones, parsing the file with `Bun.TOML.parse` before and after. Kimi checks the model before hooks, so nothing fires until signed in.

### Ollama and LM Studio (presence only)
- No hooks: margind polls every 10 s, only on this Mac, and never starts either one (running `lms` starts LM Studio's background service, so it's never used).
- **Ollama** `GET 127.0.0.1:11434/api/ps` lists loaded models with `expires_at`, which each request pushes forward: a changed `expires_at` (or a model appearing after the first look) is activity. A model kept loaded forever (`keep_alive: -1`) has a fixed expiry and isn't seen.
- **LM Studio** logs to `~/.lmstudio/server-logs/YYYY-MM/YYYY-MM-DD.N.log` as `[time][DEBUG] Received request: GET to /api/v1/models`. Only `POST` to a chat, completions, responses or messages endpoint counts; other apps poll `/v1/models` constantly. Chats inside the app change `~/.lmstudio/conversations`. The loaded model comes from `GET 127.0.0.1:1234/api/v0/models` (`state: "loaded"`) when the server is on.
- No tokens: neither keeps usage records. No project either: they have no folder.

### Shell
- zsh: `zsocket` (zsh/net/socket) writes to the daemon directly from `precmd`; throttle to directory changes or once per 60 s. `zsocket` fails on socket paths over 104 characters.
- bash 3.2 (macOS default) lacks `printf '%(%s)T'`; use `${EPOCHSECONDS:-$(date +%s)}` and background a tiny reporter.
- Shell sessions expire after 10 minutes; any AI tool session outranks a bare shell when choosing what to show.

### Repo visibility (public vs private)
- Parse `.git/config` as text (never run git in someone's repo), take the `origin` URL, ask the GitHub API `GET /repos/:owner/:repo` (unauthenticated) and cache 6 h. Anything not confirmed public is private: friends see "private project" and nothing else.

### Privacy boundary (`src/redact.ts`)
- Structural whitelist of outgoing fields, enum checks (tool, status, visibility), then a substring scan of **free-text fields only** (model, language) against local secrets (cwd, cwd basename, session ids).
- Bug we hit: scanning the whole JSON flagged key names and enum values — a folder named `vscode` matched the tool name and **crashed the daemon** (the guard threw). Scan free text only, and **fail closed** (send status only) instead of crashing.

### Text from others is untrusted
- Friends' messages, names, stuck notes and GitHub release titles can contain terminal escape sequences (OSC 52 clipboard writes, screen clears). **Strip C0/DEL/C1 control characters from everything received** before printing (`scrub` in `src/format.ts`), and on the server before storing.
- Never build shell or AppleScript source from untrusted text. `osascript -e 'on run argv' … -- " $body"`: pass values as arguments after `--`, prefixed so they can't look like flags (a message starting `-e` was executable before the fix).
- Validate handles (`^[a-z0-9](?:[a-z0-9-]{0,37}[a-z0-9])?$`) at every boundary before using them in paths.
- Treat **server responses as untrusted** too: any value that ends up in a file path (e.g. an avatar's `updatedAt`) must be checked (integer, expected shape) and the resolved path asserted to stay inside its directory before writing.

### Token usage records (checked 2026-11-21)
Margin's token total is input + output + cache writes, never cache reads (`apps/margind/src/tokens.ts`).
- **Claude Code**: `~/.claude/projects/**/*.jsonl` (subagents in `<session>/subagents/`). Assistant lines carry `message.usage` with `input_tokens` (excludes cache), `output_tokens`, `cache_creation_input_tokens`, `cache_read_input_tokens`. One response is written over several lines with the same `message.id`, and resumed/forked sessions copy earlier lines into new files: count each id once, globally.
- **Codex**: `~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl`, `event_msg` with `payload.type: "token_count"` and `payload.info.total_token_usage` = running session total: `input_tokens` (includes `cached_input_tokens`), `cache_write_input_tokens`, `output_tokens` (includes reasoning). Count `input − cached + cache_write + output` from the last event per file.
- **OpenCode**: `~/.local/share/opencode/opencode.db`, tables `session` and newer `session_v2` (same ids can be in both) with `tokens_input` (excludes cache reads), `tokens_output`, `tokens_reasoning` (separate from output), `tokens_cache_read`, `tokens_cache_write`. Open read-only.
- On the owner's Mac the first full scan (1.1 GB of Claude transcripts) took 0.8 s and matched an independent count exactly; rescans take ~10 ms.

## 4. Surfaces and macOS specifics

- **TUI** (`src/tui.ts`): raw ANSI, alternate screen, ANSI-aware clip/pad, word wrap, sidebar ≥ 76 columns else stacked, real cursor at the input line, one write per frame. Split input chunks into CSI sequences / escape pairs / single chars (pastes and arrows arrive mixed). The first key after a reveal-type animation should only dismiss it.
- **Activity-first home** tested best: friends who are in a tool first (card: name, tool · repo, model · time), then online, idle, offline (one line each); chat opens on Enter.
- **Menu bar app** (Swift, `NSStatusItem`, `NWConnection` to the Unix socket, ad-hoc signed `.app` with `LSUIElement`). `UNUserNotificationCenter` may not get permission for unsigned builds.
- **Command-line tools only (no Xcode)**: SwiftUI `@State`/`@FocusState` are macros whose plugin ships only with Xcode — keep view state in an `ObservableObject`, use `NSViewRepresentable` text fields. Multiple Swift files need the entry point in `main.swift`.
- **Docking beside another app's window without Accessibility permission**: `CGWindowListCopyWindowInfo(.optionOnScreenOnly)` gives owner PID, layer and bounds front-to-back; take the frontmost layer-0 window ≥ 300×200 of the frontmost app; convert from top-left CG coordinates to Cocoa with the primary screen height. Use a non-activating `NSPanel` (`.nonactivatingPanel`, floating, `canJoinAllSpaces`, `fullScreenAuxiliary`) so clicks don't steal focus.
- **Smoothness lessons**: chasing a window by polling looks laggy and resizing a SwiftUI panel drops frames. Never resize; fade out while the target window moves (detect frame changes, global `leftMouseDragged` monitor — mouse monitors don't need Accessibility) and fade in after ~150 ms of stillness; poll slowly at rest. Avoid docking over the app's other windows (tiled terminals).
- **LaunchAgents** for friendd (`KeepAlive`, `ThrottleInterval 10`) and the menu bar app (`open -g`, no KeepAlive so Quit sticks). Make the daemon fail closed rather than crash, or KeepAlive restarts it in a loop.

## 5. Server, data and operations

- Bun HTTP + WebSocket; GitHub device-flow login (server verifies the token once with `GET /user` and discards it; `read:user` only); dev login behind a flag; rate limits per account.
- **Postgres vs SQLite gotchas**: untyped parameters in `SELECT ... UNION SELECT $1` fail on Postgres; nested SQL fragments inside `UPDATE ... SET` are unreliable — use plain statements. Run the server suite on both (`MARGIN_TEST_DATABASE`).
- **Versioned, append-only migrations** in a `schema_migrations` table, each in a transaction; test fresh databases and upgrades from older schemas.
- **Protocol version** header (`x-margin-protocol`) with a 426 "needs an update" response, and friendd reports its version to surfaces — version skew between daemon, server and TUI crashed the TUI once.
- **Production guard**: refuse to start with dev auth on, no GitHub client id, or a non-Postgres DB.
- Account export (`GET /me/export`) and deletion (`DELETE /me`, transactional, friends notified).
- Verified ships from public GitHub data: `GET /users/:login/events/public` (ReleaseEvent, published, not draft, actor = user) and `GET /search/issues?q=type:pr author:X is:merged -user:X merged:>=<90 days>`. The events API lags a minute or more; check again ~90 s and ~6 min after a push. Settle time-boxed goals only after a check that happened after the deadline.

## 6. Testing techniques that paid off

- Two-daemon end-to-end tests over the loopback transport, and relay tests with daemons + an in-memory server; the same relay suite against Docker Postgres.
- **TUI snapshots in a pseudo-terminal** (Python `pty` + `TIOCSWINSZ`, send keys, take the last frame after `ESC[H`, strip ANSI) at several widths.
- **VS Code webview smoke tests in happy-dom**, and the extension host against a **mock `vscode` module** (activate, resolve the view, drive the embedded TUI, resize).
- Window placement checked by reading the window list (positions only), never by screenshots or driving the user's screen.
- Keep test assertions independent of the machine's idle state (presence may legitimately be `idle`).

## 7. Product decisions and preferences (from the user)

- Friends only ever see what you'd post publicly; presence is live only. Stored history is limited to things you published or earned, plus daily totals (locked-in minutes, prompt counts).
- Points must mean something: XP from finished work (releases, merged PRs), locked-in time, prompts (counted, capped), streaks, and social (kudos, helping, duels). No coins, casino, loot boxes or stakes — they looked cheap and carry App Store / loot-box regulation risk. Cosmetics, if any, are unlocked by levels/achievements, never bought or rolled; titles are achievements with visible progress.
- Pure collectible style, no corny or meme naming. Professional and deployable over feature count.
- Name: **Margin** (it lives in the margin of your terminal). `dash` was rejected: `/bin/dash` ships with macOS and Kapeli's Dash owns the name for developers.
- Don't build our own terminal; integrate with the terminal people already use. The margin should be noticeable but never in the way; plain text first, styling later.
- Too many surfaces felt cluttered (TUI, VS Code, menu bar, margin, status line, CLI, tmux pane, terminal notifications, git hook).

## 8. Mistakes not to repeat

- Building features faster than they were designed led to repeated rewrites (boxes → cases → removal; meme names → pure collectible). Agree on the product shape before coding.
- Driving the user's screen (clicks, screenshots, keystrokes into apps) was refused; verify through logs, window metadata, pseudo-terminals and test harnesses instead.
- Simulated friends lost their connections whenever the server restarted; simulators need reconnect logic, and one-time actions (challenges) must not repeat on restart.
- A dev data file (`hook-payloads.jsonl`) captured raw prompts during early hook testing; capture tooling must be deleted after use.
