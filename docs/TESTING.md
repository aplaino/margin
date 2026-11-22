# Margin — Phase 2 test results

Phase 2 is done when every row of the test matrix in [PLAN.md](PLAN.md) passes **between two different people on two different Macs, in both directions**, through the live server (https://margin-api.fly.dev). This file records what has passed, how, and what's left.

Each row needs two kinds of evidence:
- **Automated**: the test suites (`bun run check`) prove the logic on one machine, with real margind instances talking through a real server.
- **Two Macs**: a person on each Mac confirms it with the released app. The checklist at the end says exactly what to do and what you should see.

## Status

As of 2026-11-22, commit `676e0fa`, Margin 0.1.82. Automated: **178 tests pass, 0 fail** (567 checks, 15 files). **Every row passes on two Macs, both ways: Phase 2 is done.**

| Area | Automated | Two Macs | Status |
|---|---|---|---|
| Sign-in | Pass | **Pass** both ways | Done |
| Friends | Pass | **Pass** (every §2 step, both ways, on 0.1.82) | Done |
| Presence | Pass | **Pass** (Claude Code, Codex and the shell, both ways, on 0.1.82) | Done |
| Privacy | Pass | **Pass** (both ways, on 0.1.82) | Done |
| Chat | Pass | **Pass** (every §5 step, both ways, on 0.1.82) | Done |
| Tokens | Pass | **Pass** (both ways, on 0.1.82) | Done |
| Drawer | n/a (UI) | **Pass** (both ways, on 0.1.82) | Done |
| Tools | Pass | **Pass** (both ways, on 0.1.82) | Done |
| Versions | Pass | n/a | Done (automated; §9 is optional) |
| Leaks | Pass | **Pass** (both ways, on 0.1.82) | Done |

"Seen working" means it worked during the three-person test on 2026-11-21 but wasn't run step by step; it passes once the checklist row is ticked on both Macs.

## Gaps found while writing this

1. ~~No remove, block or report in the app.~~ Built: the chat header's ⋯ menu, and Unblock in Settings → Privacy.
2. ~~No safety-number verification in the app.~~ Built: ⋯ → Safety Number; the e2e test checks both Macs show the same number. Since 0.1.81 it's Signal's 60-digit format.
3. ~~One message to the owner was dropped as undecryptable after switching between the dev and live servers.~~ Fixed in 0.1.80: the receiver asks for it again and the sender resends it on a new session. Since 0.1.81 a friend's changed identity key heals the same way, in the background (DESIGN.md). Still watch for lost messages in §5.
4. **Open, not a matrix row:** on the tester's M2 in menu bar placement, Margin once stopped responding to clicks and ⌥M (it flashed when switching desktops), then recovered by itself. No crash report, nothing captured. Candidates: an update relaunching, or a hidden crash-report alert blocking the app; freeze detection would catch it next time.

## Automated evidence

All in `bun run check`. Two-user tests run two margind instances against one server.

- **Sign-in**: `signing in with GitHub` (uses the build's GitHub app, refuses a server naming another, no app means no sign-in); `signing out returns the app to the signed-out state`; `switching servers` starts signed out; api `versions and auth` (sessions required, sign-out ends the session and its socket, one account per GitHub id).
- **Friends**: api `friends` (request, accept, list, remove; mutual request makes friends at once; declining clears both sides; a block looks exactly like an unknown handle); e2e `removing a friend clears them on both sides`.
- **Presence**: e2e `a friend sees the tool, model, public repo and token total`, `close friends stop seeing activity the moment you go invisible` and `when a friend was last online survives a restart`; api `presence` (friends see it, strangers don't, late joiners get current presence, offline when the last socket closes); `sessions` (end on exit, quiet or end event; AI tool beats shell; local models rank between); tool hooks for all 13 tools (`tools.test.ts`), with real hooks confirmed firing for Qwen Code, CodeBuddy and Factory (KNOWLEDGE.md §3).
- **Privacy**: e2e `hiding tokens and going invisible take effect on the other machine`; `what friends see` (each sharing switch removes its field, repo overrides, renamed repos, close friends get the full view, invisible is indistinguishable from offline); api close-friends views.
- **Chat**: e2e `end-to-end encrypted chat both ways, with unread counts`, `a message the friend can’t read is sent again under a new session`, `a message sent while the friend is offline arrives after their daemon restarts`, `read receipts: delivered, then read once they open the chat, unless they turn them off` and `a friend with a new identity key keeps messaging, with a new safety number`; api `messages` (sender set by the server, queued until acked, retries deduplicated, friends only, blocking drops queued messages, undelivered ciphertext expires); `signal` (both ways, prekeys used once, impersonation rejected, safety numbers match); `store` (message text unreadable on disk, wrong key reads nothing).
- **Tokens**: `counting rules` (Claude Code, Codex, OpenCode; cache reads excluded); `scanning` (split and copied responses count once, only new lines read, rewritten files not double counted).
- **Stats**: `stats` (history before Margin isn't today's, local midnight, the 7- and 14-day windows, time only while working and never across a sleep, the log survives a restart); `what friends see` (each switch removes its stats, close friends only); e2e `a friend sees the tool, model, public repo and token total` (stats arrive).
- **Tools**: `connecting tools` (each tool's layout, beside the user's own hooks, backups, only Margin's entries removed, unparseable configs left alone, Kimi's TOML round-trips byte for byte); `when Margin moves` (hooks re-pointed, never from a temporary or writable copy).
- **Versions**: api `reports its protocol and refuses clients on another one` (an old client gets 426, which margind turns into the app's "Margin needs an update" state).
- **Leaks**: e2e `a private project shows as "private project" and nothing from it leaks`; `nothing from a private project leaves the machine`; `model names lose suffixes, or are dropped if odd`; the last check before presence is sent refuses anything but the exact public shape or containing local paths and session ids (`assertPublic`); crash reports are scrubbed (`reports.test.ts`); a project's `.git/config` that is a pipe, a device or huge is skipped without reading it.

## Two-Mac checklist

Two people, **A** and **B**, each on their own Mac with Margin 0.1.82 or later (Settings shows the version), signed in and friends. Do each step one way, then swap roles and do it the other way. Tick both boxes when it worked both ways; write anything odd under Results.

### 1. Sign-in
- [PASS] A→B [PASS] B→A — Settings → Account → **Sign out**. The drawer shows sign-in. Sign in with GitHub again. Your friends, chat history and token total come back.

### 2. Friends
- [PASS] A→B [PASS] B→A — B sends A a request from **Add**; A sees it under Requests with ✓ and ✕. A **declines**: it disappears on both sides. B sends again, A **accepts**: each appears in the other's Friends list within a few seconds.
- [PASS] Mutual — with a third person C who isn't a friend of A: A and C each send the other a request at about the same time. They become friends straight away, no accept needed.
- [PASS] Unknown handle — A sends a request to a GitHub handle that has never used Margin: "No Margin user called …".
- [PASS] Safety number — A and B each open the other's chat → ⋯ → **Safety Number**. Read them out: they're identical. (Passed again on 0.1.82 with the 60-digit number.)
- [PASS] Remove — A: ⋯ → **Remove Friend…** → Remove. Each disappears from the other's Friends list; the chat closes. Add each other again.
- [PASS] Block and unblock — A: ⋯ → **Block…** → Block. B: A is gone from Friends, a request to A says "No Margin user called …", and A isn't in B's Find friends. A: Settings → Privacy → Blocked → **Unblock**; B can find and add A again.
- [PASS] Report — A: ⋯ → **Report…** with a reason. It confirms without error (reports reach the server's `reports` table).
- [PASS] Find friends — B opens **Add**: A (not yet a friend) is listed and searchable by handle or name; **Add** turns into "Requested". A turns off **Show me in Find friends** (Settings → Privacy): A disappears from B's list.
- [PASS] Account — each: open Settings → Account. Your name, handle, status, tokens and friends are right, and the status matches what the other person sees on your row. The drawer's token total counts up as you use a tool.

### 3. Presence (Claude Code, Codex and the shell; the other tools are covered by the automated tests)
- [PASS] A→B [PASS] B→A — A starts the tool and sends a prompt in a **public** GitHub repo. Within 5 seconds B's strip shows A's dot and B's drawer shows A's tool, model, repo name and time.
- [PASS] Ending — A quits the tool (or leaves it alone). B sees the activity go: Claude Code at once, others after their quiet time (15 minutes; the shell 10; Ollama and LM Studio 10).
- [PASS] Idle — A leaves the Mac alone for 5 minutes. B sees A as idle (◐).
- [PASS] Last seen — A quits Margin. B's Friends list shows A as offline with when A was last online, and A's chat header says "offline · last seen …" (never online).

### 4. Privacy (A changes the setting; B watches A's row)
- [PASS] A→B [PASS] B→A — **Invisible** on: A disappears from B's online list, as if offline. Off again: back within seconds.
- [PASS] Friends see: untick **tool**, **model**, **repo**, **time** and **tokens** one at a time; each disappears from A's row on B's Mac.
- [ ] Profile switches: untick **prompts**, **time**, **tool**, **model** and **tokens** one at a time; each disappears from A's profile on B's Mac, and says Hidden on A's own profile.
- [PASS] **Close friends only** on, without B ticked: B sees only online/idle, no activity. Tick B: B sees everything again.
- [PASS] **Repo overrides**: add the repo A is working in as **Hide**: B sees A online with no activity. As **Private**: B sees "private project", never the name.

### 5. Chat
- [PASS] A→B [PASS] B→A — A sends B a message. B sees the tab slide out (or the strip glow), the unread badge, and the message in the chat. Opening the chat clears the badge.
- [PASS] Offline — B quits Margin. A sends two messages. B opens Margin: both arrive, in order.
- [PASS] Restarts — both quit and reopen Margin: the chat history is still there.
- [PASS] Chats tab — B opens **Chats**: every conversation, most recent first, with the last message and its time; the tab reads "Chats (n)" while anything is unread.
- [PASS] Pause alerts — B: Settings → Notifications → **Pause alerts** → For 1 hour. A sends a message: no tab, no glow, no macOS notification, but the unread count goes up. B presses **Resume**: the next message alerts as usual.
- [PASS] No message lost — note anything sent that never arrived (Gaps §3).
- [ ] A→B [ ] B→A — Read receipts: A sends B a message; under it A sees "Delivered", then "Read" and the time once B opens the chat. B turns off Settings → Privacy → **Send read receipts**: A's next message stays "Delivered" after B reads it, and B no longer sees "Read" under its own messages.
- [ ] A→B [ ] B→A — Links: A sends a Spotify track link. Within a few seconds both chats show a card (cover, song, artist · album, Spotify) above the link; clicking the card or the link opens it. A turns off **Link previews**: the next link arrives as a plain clickable link.

### 6. Tokens
- [ ] A→B [ ] B→A — Profile: B clicks A on Friends: A's picture, name, handle and status, this week's tokens, prompts and time, the 14-day chart, today, all time and this week. A sends a prompt in Claude Code: prompts today goes up within a minute on B's Mac. Message opens the chat; ‹ in the chat comes back to the profile; Esc goes back to the list. A's name in the chat header opens the profile. A clicks their own total: their profile as B sees it.
- [PASS] A→B [PASS] B→A — A's header shows A's total. B's drawer shows the same number on A's row (within a minute of a change). With **tokens** unticked under Friends see, it disappears from B's view.
- [PASS] Sanity — A's total is in the right ballpark for A's Claude Code, Codex and OpenCode use (it excludes cache reads, so it's lower than tools that count them).
- [ ] A→B [ ] B→A — Stats: A's card on B's Mac shows a stats line (today · wk · time · days). After A uses a tool for a few minutes, today and the time go up within a minute. Untick **tokens**: the two token numbers go; untick **time**: the time and days go. A long repo name wraps onto a second line instead of ending in ….

### 7. Drawer
- [PASS] Each Mac — the dots on the strip (or menu bar) match who's online, and the unread count matches.
- [PASS] Opening: hover, click and ⌥M each open it; untick each in Settings → Open Margin with, and it no longer opens that way.
- [PASS] Focus: hovering or clicking the edge strip doesn't take the keyboard from the app you're typing in; ⌥M and the menu bar item do; Esc gives it back.
- [PASS] Settings: after launching, the first click on ⚙ shows the Settings list, not Account (fixed in 0.1.82).
- [PASS] Language: Settings → General → Language → Español (or 中文, 日本語, Ελληνικά), **Relaunch Now**: the drawer and Settings are in that language. Back to the Mac's language afterwards.

### 8. Tools
- [PASS] Each Mac, for Claude Code, Codex and the shell — Settings → Connected tools: untick it. Its config file loses only Margin's entry (others' hooks stay), and a `.margin-backup-…` copy exists beside it. Tick it again: the hook is back and presence works again (§3).

### 9. Versions (optional)
- Covered by the automated test. To see it for real you'd need a build with an older protocol; skip unless the protocol changes.

### 10. Leaks
- [PASS] A→B [PASS] B→A — A works in a **private** repo with a distinctive folder name and branch name. B sees "private project" only; nothing on B's screen names the folder, branch, files or prompt.
- [PASS] Server — after the session, the owner runs `bun run crashes 1`: no report contains a path, handle, repo or message text.

## Results

| Date | Macs and versions | People | Rows ticked | Notes |
|---|---|---|---|---|
| 2026-11-21 | Owner's MacBook Pro (M5 Pro) and two testers' Macs incl. an M2 (testers' versions not recorded) | 3 | None formally; sign-in, friends (request/accept), presence, chat and updates seen working | One stall with high CPU on the M2, traced to multiplying menu bar observers and fixed in 0.1.61. One message dropped as undecryptable after switching servers (fixed in 0.1.80). |
| 2026-11-22 | Owner's MacBook Pro and a tester's Mac (both 0.1.82 for the second session) | 2–3 | §1 both ways; §2 all steps both ways (safety number in the 60-digit format); every step of §1–§8 and §10 both ways (§3 and §8 for Claude Code, Codex and the shell); no message lost. §8 and §10 also checked from the owner's Mac: only Margin's hook entries, others' hooks kept, backups present; no crash reports on the server | First click on ⚙ after launch opened Account (fixed in 0.1.82). |
