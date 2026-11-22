# Margin — Phase 2 test results

Phase 2 is done when every row of the test matrix in [PLAN.md](PLAN.md) passes **between two different people on two different Macs, in both directions**, through the live server (https://margin-api.fly.dev). This file records what has passed, how, and what's left.

Each row needs two kinds of evidence:
- **Automated**: the test suites (`bun run check`) prove the logic on one machine, with real margind instances talking through a real server.
- **Two Macs**: a person on each Mac confirms it with the released app. The checklist at the end says exactly what to do and what you should see.

## Status

As of 2026-11-21, commit `086b568`, Margin 0.1.61. Automated: **161 tests pass, 0 fail** (512 checks, 14 files).

| Area | Automated | Two Macs | Status |
|---|---|---|---|
| Sign-in | Pass | Seen working (3 people, informal) | Run checklist §1 (sign out and back in) |
| Friends | Pass | Request and accept seen working | **Blocked**: the app has no remove, block or report (see Gaps). Decline and mutual requests: checklist §2 |
| Presence | Pass | Seen working | Run checklist §3 (each tool you use, both directions, timing) |
| Privacy | Pass | Not yet run | Checklist §4 |
| Chat | Pass | Seen working (both ways) | Checklist §5 (offline delivery, restarts) |
| Tokens | Pass | Not yet compared | Checklist §6 |
| Drawer | n/a (UI) | Seen working | Checklist §7 |
| Tools | Pass | Not yet run | Checklist §8 |
| Versions | Pass | n/a | Passes on the automated test; a real old build is optional (§9) |
| Leaks | Pass | Not yet run | Checklist §10 |

"Seen working" means it worked during the three-person test on 2026-11-21 but wasn't run step by step; it passes once the checklist row is ticked on both Macs.

## Gaps found while writing this

1. **No remove, block or report in the app.** DESIGN.md puts them in a friend's chat header menu; margind (`friend.remove`, `block`, `report`) and the server (including unblock, `DELETE /blocks/:handle`) support them, but nothing in the drawer calls them. The Friends row can't pass until they're built.
2. **No safety-number verification in the app.** PLAN.md's v1 includes it and the Signal layer computes matching safety numbers (tested), but the drawer never shows them.
3. **Seen during testing, not a matrix row:** one message to the owner was dropped as undecryptable after switching between the dev and live servers (`dropped a message that could not be decrypted (SessionError)`). Watch for it in §5.

## Automated evidence

All in `bun run check`. Two-user tests run two margind instances against one server.

- **Sign-in**: `signing in with GitHub` (uses the build's GitHub app, refuses a server naming another, no app means no sign-in); `signing out returns the app to the signed-out state`; `switching servers` starts signed out; api `versions and auth` (sessions required, sign-out ends the session and its socket, one account per GitHub id).
- **Friends**: api `friends` (request, accept, list, remove; mutual request makes friends at once; declining clears both sides; a block looks exactly like an unknown handle); e2e `removing a friend clears them on both sides`.
- **Presence**: e2e `a friend sees the tool, model, public repo and token total`; api `presence` (friends see it, strangers don't, late joiners get current presence, offline when the last socket closes); `sessions` (end on exit, quiet or end event; AI tool beats shell; local models rank between); tool hooks for all 13 tools (`tools.test.ts`), with real hooks confirmed firing for Qwen Code, CodeBuddy and Factory (KNOWLEDGE.md §3).
- **Privacy**: e2e `hiding tokens and going invisible take effect on the other machine`; `what friends see` (each sharing switch removes its field, repo overrides, renamed repos, close friends get the full view, invisible is indistinguishable from offline); api close-friends views.
- **Chat**: e2e `end-to-end encrypted chat both ways, with unread counts` and `a message sent while the friend is offline arrives after their daemon restarts`; api `messages` (sender set by the server, queued until acked, retries deduplicated, friends only, blocking drops queued messages, undelivered ciphertext expires); `signal` (both ways, prekeys used once, impersonation rejected, safety numbers match); `store` (message text unreadable on disk, wrong key reads nothing).
- **Tokens**: `counting rules` (Claude Code, Codex, OpenCode; cache reads excluded); `scanning` (split and copied responses count once, only new lines read, rewritten files not double counted).
- **Tools**: `connecting tools` (each tool's layout, beside the user's own hooks, backups, only Margin's entries removed, unparseable configs left alone, Kimi's TOML round-trips byte for byte); `when Margin moves` (hooks re-pointed, never from a temporary or writable copy).
- **Versions**: api `reports its protocol and refuses clients on another one` (an old client gets 426, which margind turns into the app's "Margin needs an update" state).
- **Leaks**: e2e `a private project shows as "private project" and nothing from it leaks`; `nothing from a private project leaves the machine`; `model names lose suffixes, or are dropped if odd`; the last check before presence is sent refuses anything but the exact public shape or containing local paths and session ids (`assertPublic`); crash reports are scrubbed (`reports.test.ts`).

## Two-Mac checklist

Two people, **A** and **B**, each on their own Mac with Margin 0.1.61 or later (Settings shows the version), signed in and friends. Do each step one way, then swap roles and do it the other way. Tick both boxes when it worked both ways; write anything odd under Results.

### 1. Sign-in
- [ ] A→B [ ] B→A — Settings → Account → **Sign out**. The drawer shows sign-in. Sign in with GitHub again. Your friends, chat history and token total come back.

### 2. Friends
- [ ] A→B [ ] B→A — B sends A a request from **Add**; A sees it under Requests with ✓ and ✕. A **declines**: it disappears on both sides. B sends again, A **accepts**: each appears in the other's Friends list within a few seconds.
- [ ] Mutual — with a third person C who isn't a friend of A: A and C each send the other a request at about the same time. They become friends straight away, no accept needed.
- [ ] Unknown handle — A sends a request to a GitHub handle that has never used Margin: "No Margin user called …".
- Remove, block and report: **not testable** until the chat header menu exists (Gaps).

### 3. Presence (for each tool you use: Claude Code, Codex, OpenCode, Cursor, Gemini CLI, the shell…)
- [ ] A→B [ ] B→A — A starts the tool and sends a prompt in a **public** GitHub repo. Within 5 seconds B's strip shows A's dot and B's drawer shows A's tool, model, repo name and time.
- [ ] Ending — A quits the tool (or leaves it alone). B sees the activity go: Claude Code at once, others after their quiet time (15 minutes; the shell 10; Ollama and LM Studio 10).
- [ ] Idle — A leaves the Mac alone for 5 minutes. B sees A as idle (◐).

### 4. Privacy (A changes the setting; B watches A's row)
- [ ] A→B [ ] B→A — **Invisible** on: A disappears from B's online list, as if offline. Off again: back within seconds.
- [ ] Friends see: untick **tool**, **model**, **repo**, **time** and **tokens** one at a time; each disappears from A's row on B's Mac.
- [ ] **Close friends only** on, without B ticked: B sees only online/idle, no activity. Tick B: B sees everything again.
- [ ] **Repo overrides**: add the repo A is working in as **Hide**: B sees A online with no activity. As **Private**: B sees "private project", never the name.

### 5. Chat
- [ ] A→B [ ] B→A — A sends B a message. B sees the tab slide out (or the strip glow), the unread badge, and the message in the chat. Opening the chat clears the badge.
- [ ] Offline — B quits Margin. A sends two messages. B opens Margin: both arrive, in order.
- [ ] Restarts — both quit and reopen Margin: the chat history is still there.
- [ ] No message lost — note anything sent that never arrived (Gaps §3).

### 6. Tokens
- [ ] A→B [ ] B→A — A's header shows A's total. B's drawer shows the same number on A's row (within a minute of a change). With **tokens** unticked under Friends see, it disappears from B's view.
- [ ] Sanity — A's total is in the right ballpark for A's Claude Code, Codex and OpenCode use (it excludes cache reads, so it's lower than tools that count them).

### 7. Drawer
- [ ] Each Mac — the dots on the strip (or menu bar) match who's online, and the unread count matches.
- [ ] Opening: hover, click and ⌥M each open it; untick each in Settings → Open Margin with, and it no longer opens that way.
- [ ] Focus: hovering or clicking the edge strip doesn't take the keyboard from the app you're typing in; ⌥M and the menu bar item do; Esc gives it back.

### 8. Tools
- [ ] Each Mac, each tool you use — Settings → Connected tools: untick it. Its config file loses only Margin's entry (others' hooks stay), and a `.margin-backup-…` copy exists beside it. Tick it again: the hook is back and presence works again (§3).

### 9. Versions (optional)
- Covered by the automated test. To see it for real you'd need a build with an older protocol; skip unless the protocol changes.

### 10. Leaks
- [ ] A→B [ ] B→A — A works in a **private** repo with a distinctive folder name and branch name. B sees "private project" only; nothing on B's screen names the folder, branch, files or prompt.
- [ ] Server — after the session, the owner runs `bun run crashes 1`: no report contains a path, handle, repo or message text.

## Results

| Date | Macs and versions | People | Rows ticked | Notes |
|---|---|---|---|---|
| 2026-11-21 | Owner's MacBook Pro (M5 Pro) and two testers' Macs incl. an M2 (testers' versions not recorded) | 3 | None formally; sign-in, friends (request/accept), presence, chat and updates seen working | One stall with high CPU on the M2, traced to multiplying menu bar observers and fixed in 0.1.61. One message dropped as undecryptable after switching servers. |
