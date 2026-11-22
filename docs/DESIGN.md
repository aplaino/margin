# Margin — design (v1)

Agreed with the owner on 2026-11-21 (Phase 1). This is the source of truth for what Margin looks like and how it behaves. Anything not described here is out of scope for v1; propose changes to the owner before building them.

## 1. Purpose

Margin shows what your friends are building, from one fixed spot at the edge of your screen, without getting in the way of your own work. Glance at it to see who's coding and in what; open it to see details, chat, add friends or change settings.

**One home.** Margin is a single drawer, at a screen edge or under its menu bar item. It never follows windows (the prototype's window-docking felt glitchy) and draws nothing inside terminals or editors. Terminals and AI tools are activity sources only.

## 2. Placement

- **Moving it: drag the strip.** Drag along the edge to put it at any height; drag it across the screen and it switches to the other edge as the pointer crosses the middle, settling on the side you let go. A press that moves less than 3 px is a click. The cursor shows a closed hand while dragging, and hover-to-open waits until you let go.
- **Edge:** right by default.
- **Vertical position:** saved as a fraction of the screen height, so it holds across displays and resolutions. Until you move it: the middle, except when the Dock sits on the same edge, then near the top, so hovering Margin never reveals the Dock. (The owner's Dock auto-hides on the right, vertically centred.) Settings has **Reset position**.
- **Opening:** the drawer opens downward from a strip in the top half of the screen and upward from one in the bottom half.
- **Range:** the strip can sit anywhere from just under the menu bar to the bottom of the screen (above the Dock when it's on that edge and not hidden). Parking it in a corner can put it next to a hot corner; that's your call.
- **Display:** the screen that contains the frontmost window (falling back to the one with the pointer). It moves to another display only when you switch work there, never while open.
- **Full-screen apps and Spaces:** visible on every Space and over full-screen apps.
- **Stage Manager:** sits above the stage; unaffected.
- **Menu bar (agreed with the owner 2026-11-21, at a user's request):** Settings → Position → **Screen edge | Menu bar**; one or the other, never both. In the menu bar, Margin is a menu bar item, which macOS places beside the notch on the right (or at the right of a menu bar without one); ⌘-drag moves it. The left of the notch is the active app's menus, where macOS reserves nothing, so Margin doesn't go there. The item shows up to 6 dots (● in a tool, ◐ idle), then `+N`, then the unread badge; a dim dot when nobody's online, a hollow one when signed out. Hover, click and ⌥M open the drawer, which slides down from under the menu bar with its top corners square; the new-message tab slides down under the item. When macOS tucks the item under the notch because the menu bar is full, the edge strip appears after 2 s until there's room, and Settings says why. When the whole menu bar is hidden (a full-screen app, or a menu bar set to hide), Margin hides with it and comes back with it; no strip appears (owner's call, 2026-11-21).

## 3. Collapsed state (always visible)

```
  screen edge ─▶ │
                 ▐   ← top of strip
                 ●   in a tool (Claude Code, Codex, Cursor, a local model, shell…)
                 ●
                 ●
                 ◐   idle (online, no recent activity)
                 ·
                 2   unread messages
                 ▐   ← bottom of strip
```

- A slim, translucent strip about **8 px wide**, flush with the screen edge, only as tall as its content. Minimum height 32 px.
- **One dot per online friend**: solid ● in a tool, ◐ idle. Offline friends aren't shown. Order: in a tool, then idle, each by most recent change.
- More than 12 online friends: the first 12 dots, then `+N`.
- **Unread count** below the dots when above zero.
- **New message:** the strip pulses three times, the unread count becomes a filled badge until read, and a tab slides out beside the strip for about 4 seconds showing the sender and the first words ("Maya: want to pair…"). Hovering keeps the tab out; clicking it opens the chat. No tab while you're reading that chat. Settings → Notifications chooses **Peek with a preview** (default, the owner's choice), **Peek with the name**, or **Glow only**; the preview option notes that anyone looking at the screen can read it. macOS notifications stay off by default.
- **Nobody online, nothing unread:** the strip fades to a faint hairline (3 px, 25% opacity) at the screen edge, so there's no dark notch when there's nothing to see. It stays in place and still opens on hover or click; it comes back to full strength while the pointer is on it and as soon as a friend comes online or a message arrives. It fades only while hover-to-open is on: with hover off the strip has to be seen to be clicked, so it stays at full strength (the owner lost it at the top of the right edge, faded, with hover off). On by default; Settings → Position → **Fade the strip when nobody's online** turns it off.
- **Not signed in / daemon not running:** a single hollow ○ dot; expanding shows what to do.
- **Click-through:** only the strip's own pixels take the pointer. Anything outside it, such as a window's scroll bar or resize edge, behaves as if Margin weren't there.
- Colours follow light/dark mode; the strip is translucent so the window behind stays visible at the edges.

## 4. Expanding and collapsing

| Trigger | Default | Behaviour |
|---|---|---|
| Hover | On | Pointer rests on the strip for 250 ms (intent delay, so passing over doesn't open it) |
| Click | On | Click the strip |
| Hotkey | On, ⌥M | Toggles open/closed from anywhere |

Each trigger is switchable in settings, and the hotkey can be changed.

**Collapses when:** the pointer leaves the expanded panel for 400 ms (only if it was opened by hover), you press Esc, you press the hotkey again, or you click outside it. **Never** while you're typing in a field.

**Animation:** slides out from the edge in 150 ms; with Reduce Motion on, it fades instead.

**Focus:** opening Margin doesn't take keyboard focus from your work. It takes focus when you click into it, click its menu bar item (as any menu would), or open it with the hotkey; hovering or clicking the edge strip doesn't. Esc returns focus to the app you were in.

**Keyboard (when the drawer has focus — opened with ⌥M or from the menu bar item, or once you click into it):** ↑/↓ move through friends (the selected row is outlined in the accent colour and scrolled into view), Return opens the chat with the message field ready, Tab/⇧Tab step through Friends, Add and Settings, ⌘1/⌘2/⌘3 jump to them, Esc goes back one level (chat → list → collapsed). On Add and Settings, ↑/↓ outline each control in turn, Space or Return toggles or presses it (or puts you in a text field), and ←/→ change a choice (appearance, theme, accent, new-message alert); Esc leaves a text field. While typing in a field, keys stay with the field.

## 5. Expanded panel

About **260 px** wide, as tall as needed up to 70 % of the screen height, anchored at the strip's vertical position. Translucent, rounded inner corners, native system font.

### Header and tabs
```
┌──────────────────────────────┐
│ 118.7M tokens · all time     │  ← your total tokens across connected tools
│ Friends    Add (1)    ⚙      │  ← (1) = incoming requests
├──────────────────────────────┤
```

**Tokens** replace XP. Each person's number is their all-time total of input, output and cache-write tokens across Claude Code, Codex and OpenCode; cache reads are excluded because they repeat the same context on every turn and would swamp the number. Shown as 2.4M / 48.1M (one decimal). It's read locally from each tool's own usage records (Claude Code transcripts carry per-message `usage`; Codex and OpenCode sources to be confirmed in Phase 2) and only the total is sent. Your own total heads the drawer, rolling up as tokens come in. Settings → General → **Token total** picks its unit (Millions by default; Exact, Auto, Thousands, Billions, Trillions, Lakh, Crore), one of 29 notations from the game Antimatter Dimensions and its community (Engineering, Letters, Emoji, Logarithm, Brackets, Infinity, Roman, Dots, Zalgo, Hex, Imperial, Clock, Prime, Shi, Blind, All; Greek Letters, Omega, Japanese, Chinese, Elemental, Binary, Hexadecimal, English, Flags, Yes/No, Emojier, Tritetrated, Precise Prime; ported from its MIT-licensed library in `Notations.swift`), or **Scientific notation** (1.19 × 10⁸); anything but the default drops the "tokens · all time" label so the line doesn't wrap, and a number that still doesn't fit ends in …; it's also in Settings → Account, on every friend's row, in the chat header and on offline friends. You can hide it from friends under Privacy → Friends see → tokens.

### Friends tab
```
│ ● Maya Chen            48.1M │
│   Claude Code · tidepool-ui  │  tool · public repo (or "private project")
│   claude-opus-5-5 · 3h 4m    │  model · time in this session
│ ● Leo Park          21.7M  2 │  ← unread from Leo
│   Codex · private project    │
│   gpt-6.1-sol · 47m          │
│ ◐ Sam Rivera           12.9M │
│   idle · OpenCode · glyphs   │
│                              │
│ OFFLINE                      │
│ ○ Jules Martin  6.8M · 4h ago│
└──────────────────────────────┘
```
- Online first (in a tool, then idle), then offline in one line each with "last seen".
- Click (or Enter on) a friend to open the chat.
- Empty states: "No friends yet — Add someone by their GitHub handle" (with the Add tab highlighted); "Nobody's online right now".

### Chat
```
┌──────────────────────────────┐
│ ‹  Maya Chen                 │
│    Claude Code · tidepool-ui │
├──────────────────────────────┤
│ shipped the new parser!      │
│               nice, how fast │
│               is it now?     │
│ 2x on the big fixtures       │
├──────────────────────────────┤
│ [ Message Maya             ] │
│      End-to-end encrypted    │
└──────────────────────────────┘
```
- Theirs on the left, yours on the right; history loads when the chat opens.
- Enter sends; Esc goes back to the list. Opening a chat marks it read.
- Copying: right-click a message → Copy, or with the field empty press ↑ to outline your last message, ↑/↓ to pick another, and ⌘C to copy the whole message. ↓ past the last message, Esc, or typing returns to the field. Text inside a message can still be selected with the pointer.
- Friend-written text is displayed as plain text (control characters stripped).

### Add tab
```
┌──────────────────────────────┐
│ Add a friend                 │
│ [ github handle    ] [Send]  │
│                              │
│ REQUESTS                     │
│ carol          [✓]  [✕]      │
│ SENT                         │
│ dave           pending       │
└──────────────────────────────┘
```
- Requests go by GitHub handle; a mutual request makes you friends straight away.
- Unknown and blocked handles get the same "not found" (blocks aren't observable).
- **Find friends (agreed with the owner 2026-11-21):** below the requests, a search over everyone on Margin who can be found (handle or GitHub name), each with **Add**, or "Requested" once asked. It never shows you, your friends, anyone who switched it off, anyone who has blocked you or anyone you've blocked, and never shows activity. Everyone is findable by default (the owner's call); Settings → Privacy → **Show me in Find friends** switches it off. The server keeps only that one flag; searches are limited to 300 an hour.
- **Friend actions** are in the chat header's ⋯ menu: **Safety Number** (the 20-character fingerprint of both identity keys, the same on both Macs, to compare in person or on a call), **Remove Friend…**, **Block…** (also unfriends and deletes what they queued for you; to them you look like you're not on Margin) and **Report…** (an optional reason, with "Also block"). Remove and block ask first. Settings → Privacy lists who you've blocked, with **Unblock**.

### Settings (⚙)
```
┌──────────────────────────────┐
│ ⓐ Andreas                  › │  account card → Account
│   @aplaino · Margin account  │
│ ┌──────────────────────────┐ │
│ │ ⚙ General              › │ │
│ │ ◐ Appearance           › │ │
│ │ ▥ Placement            › │ │
│ └──────────────────────────┘ │
│ ┌──────────────────────────┐ │
│ │ 🔔 Notifications        › │ │
│ │ ✋ Privacy & Security   › │ │
│ │ 🔨 Connected Tools      › │ │
│ └──────────────────────────┘ │
│ │ Quit Margin              │ │
└──────────────────────────────┘
‹ General
OPEN MARGIN WITH  Hover ◉  Click ◉  ⌥M from anywhere ◉
Open at login ◉ · Version 0.1.x  Check for Updates
CRASH REPORTS  Send reports [Ask after a crash ▾] · How Margin works  Show
```
- **Organised like System Settings (owner's call, 2026-11-22):** your account on a card at the top, then categories with coloured icon tiles in two groups, each opening its own page of grouped cards (label left, control right, switches for on/off). The drawer is too narrow for System Settings' sidebar beside a page, so, as on iPhone, the list opens one page at a time; ‹ or Esc goes back.
- **Pages:** **Account** (name and handle; status, the presence dot and what you're doing as close friends see it, or Invisible; token total; friends and how many are online; export your data, sign out, delete account. Plain rows like the other pages: it replaced the separate profile page, owner's call 2026-11-22); **General** (open with hover, click, ⌥M; token total unit or scientific notation; open at login; version and updates; crash reports; how Margin works); **Appearance** (Auto, Light, Dark; theme gallery; accent colour; custom theme); **Placement** (screen edge or menu bar; fade; reset position); **Notifications** (new messages: preview, name only or glow only; macOS notifications); **Privacy & Security** (invisible; Find friends; what friends see; close friends; blocked; repo overrides); **Connected Tools**.
- **Connected tools:** Claude Code, Codex, OpenCode, Gemini CLI, Qwen Code, Factory, CodeBuddy, Qoder, Kimi Code, Cursor, Ollama, LM Studio and the shell; tools that aren't installed are marked "not found". Ollama and LM Studio install nothing: margind watches their local servers while they're ticked (on by default when installed) and shows the model, never a project or tokens. For the rest, turning one on explains what will change ("adds a hook to ~/.claude/settings.json"), asks, backs the file up, then installs. Turning it off removes only Margin's entry. Margin's hooks print nothing into Claude's context.
- **Crash reports (agreed with the owner 2026-11-21):** General → **Crash reports: Ask after a crash** (default) | Always send | Never send, with a line on what a report holds. margind keeps a report when it crashes (an unexpected error: it writes the report, exits, and the app restarts it), when macOS writes a crash report for Margin or margind, and for serious errors it survives (presence withheld by the privacy check, a failed token scan, keys that can't be pinned, a message that can't be decrypted, a server frame or request that fails unexpectedly, hooks that can't be updated; being offline doesn't count). A report holds the app and macOS versions, which part, what broke, the stack or crashed thread, and margind's last 50 log lines, and is scrubbed on the Mac first: paths, your and friends' handles and names, repo names, local folders, emails, URL queries and anything token-like are removed. It carries a random install id, never an account. After a crash Margin asks once: **Send Report** / **Don't Send**, with **Always send reports**; errors that aren't crashes wait (up to 20) and go with the next report you send, or from Settings, which shows "N reports waiting · Send · Discard". The server takes at most 64 KB per report, 30 a day per install and 100 an hour per address; new install ids share 1,000 an hour, and a hard ceiling of 5,000 an hour caps everything stored (owner's call, 2026-11-21: a flood can cost an hour of reports, never unbounded storage, so known installs are not exempt). It keeps them 90 days, and only the release token can read them (`bun run crashes`).
- **Theme:** a gallery of ten tiles, each shown as a miniature drawer, like the Appearance tiles in System Settings. A theme sets colours, fonts and weights, corner shapes, the panel material (solid or frosted glass) and texture, and the dots' shape and colours; each has a light and a dark version, picked by **Appearance** (System, Light, Dark).
  - **Graphite** (default): SF Pro, neutral greys, near-solid panel.
  - **Glass**: frosted material that blurs what's behind, like Control Center.
  - **Paper**: warm paper or charcoal, New York serif headings and names.
  - **Terminal**: SF Mono throughout, square corners.
  - **High Contrast**: pure black or white, heavier text, stronger borders.
  - Mac-styled, after each era's look with our own names, never Apple's (agreed with the owner 2026-11-22):
    - **Classic**: late-'90s platinum grey, black outlines, bevelled edges, nearly square corners.
    - **Gel**: early Mac OS X pinstripes, soft rounded shapes.
    - **Modern Glass**: today's clear glass, large round corners, light borders.
    - **Midnight**: the 2018-era deep charcoal dark mode with a little vibrancy; always dark (the window is dark too, so system controls match).
  - **Custom**: opens the editor (also Settings → Edit custom theme…). One custom theme, saved on the Mac: **Start from** any theme, then change **Colours** (background, panels, text, borders, accent), **Text** (system, rounded, serif, monospaced or any installed typeface; light, regular or medium; 85–125% size), **Shapes** (roundness from square to round; frosted glass on or off) and **Dots** (circle, square, diamond or ring; 80–180% size; colours for in a tool, idle and unread). Changes apply at once; anything unchanged follows the starting theme's light and dark versions; **Reset** clears the changes.

  **Visual rules (2026-11-22):** a corner nested inside the panel follows its curve (`Theme.nested`: the panel's radius minus how far in it sits, at least 4 pt); borders are partly transparent so they blend into any background (a custom border is applied at 45%); icons beside text take the text's weight; scrolling lists fade out softly at the top and bottom, within their own padding; and content that swaps (Settings pages, Add → Requested) blurs across, with unread counts rolling to the new number.

  Laid out like System Settings → Appearance (owner's call, 2026-11-22): titled groups on rounded cards, label left and control right; **Appearance** as three picture tiles (Auto, Light, Dark), the theme gallery, and **Accent colour** as a row of circles (blue, purple, pink, red, orange, yellow, green, graphite) with a white centre on the selected one and its name underneath. The custom theme editor uses the same cards; each colour is a swatch that opens a palette in place, with a hex box and **Other…** for the macOS colour window (Margin is brought forward for it, and a hover-opened drawer stays open while it's showing; SwiftUI's own colour picker can't open from the drawer).

  The **accent** is separate and works with every theme (a custom theme can override it): your chat bubbles, buttons and the selected tab. Presence dots are green for in a tool and amber for idle unless a custom theme changes them, and then the chosen colours and shape apply everywhere (strip, menu bar, rows, profile). Idle is always half-filled, so it never depends on colour alone. Every colour, font, size and shape comes from the theme definition (`apps/mac/Sources/Margin/Theme.swift`, `CustomTheme.swift`); nothing is hard-coded in views, so adding a theme is adding a value.
- **Privacy:** as in KNOWLEDGE.md — invisible, which fields friends see, close friends only (others see online/idle), per-repo "hidden" or "always private".

## 6. First launch

A strip at the screen edge or a few dots in the menu bar are easy to miss, so the first time Margin runs it opens a **welcome window** in the middle of the screen (the only window it ever opens on its own; agreed with the owner 2026-11-21): the icon, "Welcome to Margin", one line on what it does, and **Where should it live?** with two picture tiles, **Screen edge** (default) and **Menu bar** (beside the notch), noting it can be changed in Settings. **Get started** (or closing the window) opens the drawer where Margin now lives, with the strip or menu bar item pulsing, and setup carries on inside it from step 2. People who finished setup before this existed never see it.

The rest is shown inside the expanded drawer:

```
1. Welcome          2. Sign in                3. Connect tools           4. Add friends
Margin shows what   Enter this code on        ☑ Claude Code              [ github handle ] [Send]
your friends are    github.com/login/device   ☑ Codex
building, right     ┌──────────┐              ☐ OpenCode (not found)     Skip for now
here at the edge.   │ ABCD-1234│              ☐ Shell (zsh)
[Get started]       └──────────┘              [Continue]
                    (browser opens)
```
- Tools that aren't installed are shown as "not found" and can't be enabled.
- After step 4 the drawer collapses to the strip.

## 7. States

| State | Strip | Expanded |
|---|---|---|
| Signed out | ○ | First-launch flow |
| Daemon not running | ○ | "Margin's background service isn't running" + Restart |
| Offline (no network) | dots greyed | Banner "Offline — reconnecting"; chat queues messages |
| Server needs a newer app | ○ | "Update Margin" with link (protocol version mismatch) |
| No friends | (strip with no dots) | Friends tab empty state pointing to Add |

## 8. Activity sources (v1)

Claude Code, Codex, OpenCode, Gemini CLI, Qwen Code, Factory, CodeBuddy, Qoder, Kimi Code, Cursor and the shell (zsh/bash) report activity through hooks/plugins; Ollama and LM Studio are watched through their local servers (KNOWLEDGE.md §3). When several are active, friends see a coding tool first, then a local model, then the shell. **Not in v1:** VS Code, a TUI, the Claude Code status line. A `margin` CLI exists only for diagnostics (`margin doctor`).

## 9. Defaults

| Setting | Default |
|---|---|
| Edge | Right |
| Vertical position | Middle; near the top if the Dock is on the same edge (until dragged) |
| Open with hover / click / hotkey | On / On / On |
| Hotkey | ⌥M |
| Hover intent delay | 250 ms |
| Collapse after pointer leaves | 400 ms |
| Max dots | 12, then +N |
| Fade the strip when nobody's online | On |
| macOS notifications | Off |
| Invisible | Off |
| Friends see | Tool, model, repo, time, tokens |
| Theme | Graphite, System appearance, blue accent |
| Audience | Everyone (not close friends only) |
| Connected tools | Chosen during first launch |
| Language | The Mac's own (System Settings → General → Language & Region), English otherwise |
| Token total | Millions (118.7M) |

## 9a. Languages (agreed with the owner 2026-11-22)

The Mac app speaks English, Spanish, Simplified Chinese, Japanese and Greek, following the Mac's language order; System Settings → General → Language & Region → Applications can set Margin alone. There's no language menu in Margin. Names, handles, repos, messages, tool and model names stay as they are, and so do the error messages margind sends (English for now). The website stays in English. Translations were drafted by Claude and need a native speaker's read before a release that advertises them.

## 10. Distribution

Margin edits other tools' config files to install hooks, so it ships as a signed, notarized direct download and via Homebrew, not the Mac App Store.
