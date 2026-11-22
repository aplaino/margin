# Margin — design (v1)

Agreed with the owner on 2026-11-21 (Phase 1). This is the source of truth for what Margin looks like and how it behaves. Anything not described here is out of scope for v1; propose changes to the owner before building them.

## 1. Purpose

Margin shows what your friends are building, from one fixed spot at the edge of your screen, without getting in the way of your own work. Glance at it to see who's coding and in what; open it to see details, chat, add friends or change settings.

**One home.** Margin is a single screen-edge drawer. It never follows windows (the prototype's window-docking felt glitchy) and draws nothing inside terminals or editors. Terminals and AI tools are activity sources only.

## 2. Placement

- **Moving it: drag the strip.** Drag along the edge to put it at any height; drag it across the screen and it switches to the other edge as the pointer crosses the middle, settling on the side you let go. A press that moves less than 3 px is a click. The cursor shows a closed hand while dragging, and hover-to-open waits until you let go.
- **Edge:** right by default.
- **Vertical position:** saved as a fraction of the screen height, so it holds across displays and resolutions. Until you move it: the middle, except when the Dock sits on the same edge, then near the top, so hovering Margin never reveals the Dock. (The owner's Dock auto-hides on the right, vertically centred.) Settings has **Reset position**.
- **Opening:** the drawer opens downward from a strip in the top half of the screen and upward from one in the bottom half.
- **Range:** the strip can sit anywhere from just under the menu bar to the bottom of the screen (above the Dock when it's on that edge and not hidden). Parking it in a corner can put it next to a hot corner; that's your call.
- **Display:** the screen that contains the frontmost window (falling back to the one with the pointer). It moves to another display only when you switch work there, never while open.
- **Full-screen apps and Spaces:** visible on every Space and over full-screen apps.
- **Stage Manager:** sits above the stage; unaffected.

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
- **Nobody online, nothing unread:** the strip fades to a faint hairline (3 px, 25% opacity) at the screen edge, so there's no dark notch when there's nothing to see. It stays in place and still opens on hover or click; it comes back to full strength while the pointer is on it and as soon as a friend comes online or a message arrives. On by default; Settings → Position → **Fade the strip when nobody's online** turns it off.
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

**Focus:** opening Margin doesn't take keyboard focus from your work. It takes focus only when you click a text field (chat, add friend) or open it with the hotkey. Esc returns focus to the app you were in.

**Keyboard (when the drawer has focus — opened with ⌥M, or once you click into it):** ↑/↓ move through friends (the selected row is outlined in the accent colour and scrolled into view), Return opens the chat with the message field ready, Tab/⇧Tab step through Friends, Add and Settings, ⌘1/⌘2/⌘3 jump to them, Esc goes back one level (chat → list → collapsed). On Add and Settings, ↑/↓ outline each control in turn, Space or Return toggles or presses it (or puts you in a text field), and ←/→ change a choice (appearance, theme, accent, new-message alert); Esc leaves a text field. While typing in a field, keys stay with the field.

## 5. Expanded panel

About **260 px** wide, as tall as needed up to 70 % of the screen height, anchored at the strip's vertical position. Translucent, rounded inner corners, native system font.

### Header and tabs
```
┌──────────────────────────────┐
│ 14.2M tokens · all time      │  ← your total tokens across connected tools
│ Friends    Add (1)    ⚙      │  ← (1) = incoming requests
├──────────────────────────────┤
```

**Tokens** replace XP. Each person's number is their all-time total of input, output and cache-write tokens across Claude Code, Codex and OpenCode; cache reads are excluded because they repeat the same context on every turn and would swamp the number. Shown as 2.4M / 48.1M (one decimal). It's read locally from each tool's own usage records (Claude Code transcripts carry per-message `usage`; Codex and OpenCode sources to be confirmed in Phase 2) and only the total is sent. It appears in your header, on every friend's row, in the chat header and on offline friends. You can hide it from friends under Privacy → Friends see → tokens.

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
- Friend actions (remove, block, report) are in a friend's chat header menu.

### Settings (⚙)
```
┌──────────────────────────────┐
│ OPEN MARGIN WITH             │
│ ☑ Hover   ☑ Click   ☑ ⌥M  ✎ │
│ POSITION                     │
│ Drag the strip to move it.   │
│ Reset position               │
│ ☑ Fade when nobody's online  │
│ THEME                        │
│ [System | Light | Dark]      │
│ ▢Graphite ▢Glass  ▢Paper     │
│ ▢Terminal ▢High Contrast     │
│ Accent  ● ● ● ● ●            │
│ CONNECTED TOOLS              │
│ ☑ Claude Code   ☑ Codex      │
│ ☑ OpenCode      ☑ Cursor     │
│ ☐ Gemini CLI    ☑ Ollama     │
│ …               ☐ Shell (zsh)│
│ PRIVACY                      │
│ ☐ Invisible                  │
│ Friends see: ☑ tool ☑ model  │
│   ☑ repo ☑ time ☑ tokens     │
│ Close friends only ▸         │
│ Repo overrides ▸             │
│ NOTIFICATIONS                │
│ ☐ macOS notifications        │
│ ACCOUNT                      │
│ @aplaino · Sign out          │
│ Export data · Delete account │
│ Quit Margin                  │
└──────────────────────────────┘
```
- **Connected tools:** Claude Code, Codex, OpenCode, Gemini CLI, Qwen Code, Factory, CodeBuddy, Qoder, Kimi Code, Cursor, Ollama, LM Studio and the shell; tools that aren't installed are marked "not found". Ollama and LM Studio install nothing: margind watches their local servers while they're ticked (on by default when installed) and shows the model, never a project or tokens. For the rest, turning one on explains what will change ("adds a hook to ~/.claude/settings.json"), asks, backs the file up, then installs. Turning it off removes only Margin's entry. Margin's hooks print nothing into Claude's context.
- **Theme:** a gallery of five themes, each shown as a miniature drawer, like the Appearance tiles in System Settings. A theme sets colours, fonts and weights, corner shapes and the panel material (solid or frosted glass); each has a light and a dark version, picked by **Appearance** (System, Light, Dark).
  - **Graphite** (default): SF Pro, neutral greys, near-solid panel.
  - **Glass**: frosted material that blurs what's behind, like Control Center.
  - **Paper**: warm paper or charcoal, New York serif headings and names.
  - **Terminal**: SF Mono throughout, square corners.
  - **High Contrast**: pure black or white, heavier text, stronger borders.

  The **accent** (blue, green, orange, purple, graphite) is separate and works with every theme: your chat bubbles, buttons and the selected tab. Presence colours stay green for in a tool and amber for idle in every theme, so the strip always reads the same. Every colour, font, size and shape comes from the theme definition (`apps/mac/Sources/Margin/Theme.swift`); nothing is hard-coded in views, so adding a theme is adding a value.
- **Privacy:** as in KNOWLEDGE.md — invisible, which fields friends see, close friends only (others see online/idle), per-repo "hidden" or "always private".

## 6. First launch

Shown inside the expanded drawer the first time Margin runs:

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

Claude Code, Codex, OpenCode, Gemini CLI, Qwen Code, Factory, CodeBuddy, Qoder, Kimi Code, Cursor and the shell (zsh/bash) report activity through hooks/plugins; Ollama and LM Studio are watched through their local servers (KNOWLEDGE.md §3). When several are active, friends see a coding tool first, then a local model, then the shell. **Not in v1:** VS Code, a TUI, the Claude Code status line, a menu bar icon. A `margin` CLI exists only for diagnostics (`margin doctor`).

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

## 10. Distribution

Margin edits other tools' config files to install hooks, so it ships as a signed, notarized direct download and via Homebrew, not the Mac App Store.
