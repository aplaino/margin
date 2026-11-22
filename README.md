# Margin

See what your friends are building, from one spot at the edge of your screen.

Margin is a Mac app that lives as a thin strip on the edge of your display. Each dot is a friend who's coding right now. Open it to see which tool and model they're using and which public repo they're in, how many tokens they've spent all time, and to chat with them, end-to-end encrypted.

**Download:** [margin-api.fly.dev](https://margin-api.fly.dev) (early beta, updates itself). Or paste into Terminal:

```sh
curl -fsSL https://margin-api.fly.dev/install.sh | sh
```

Requires macOS 26 or later on Apple silicon.

## Works with

Claude Code, Codex, OpenCode, Cursor, Gemini CLI, Qwen Code, Factory, CodeBuddy, Qoder, Kimi Code, Ollama, LM Studio and the shell (zsh).

Turn a tool on in Settings and Margin adds a small hook to its config, backing the file up first; turning it off removes only Margin's entry. Hooks print nothing into your sessions. Ollama and LM Studio need nothing installed: Margin notices when a local model is answering and shows its name.

## Privacy

- Friends see only what you'd post publicly: the tool, the model, a public repo's name (private ones show as "private project"), how long you've been at it, and your token total. Each of these can be switched off, shown to close friends only, or overridden per repo.
- Prompts, replies, file names, branches and paths never leave your Mac. Hooks whitelist a handful of fields, and a final check blocks anything that isn't exactly the public shape.
- Chat is end-to-end encrypted with the Signal protocol; the server only ever holds ciphertext.
- Privacy is enforced on your Mac, never trusted to the server.

## How it's built

```
tool hooks, OpenCode plugin, shell, local model polling ─▶ margind ─▶ api ─▶ friend's margind ─▶ friend's drawer
                                                              ▲
                                         Margin.app (drawer) ─┘ local socket
```

- `apps/mac`: Margin.app, the drawer (Swift/SwiftUI). The only UI.
- `apps/margind`: background service on your Mac (Bun): sessions, privacy checks, encrypted local store, Signal sessions, tool hooks, token totals.
- `apps/api`: server (Bun, Postgres): GitHub sign-in, friends, key directory, presence fan-out, ciphertext queue. Also serves the website in `apps/web` and app updates.
- `packages/protocol`: Valibot schemas shared by every TypeScript component.

## Developing

```sh
bun install
bun run check   # lint, typecheck, tests
bun run dev     # local server, your margind, simulated friends, and Margin.app
```

`docs/DESIGN.md` describes the drawer, `docs/PLAN.md` the phases and scope, and `docs/KNOWLEDGE.md` what was learned about each tool's hooks.

## License

Margin is free software under the [GNU Affero General Public License v3.0 or later](LICENSE). You can use, change and share it; if you distribute a modified Margin, or run a modified server for other people, you must offer its source under the same license.

It includes [libsignal-node](https://github.com/WhiskeySockets/libsignal-node) (GPL-3.0), [Sparkle](https://github.com/sparkle-project/Sparkle) (MIT) and number notations ported from [Antimatter Dimensions' notations library](https://github.com/antimatter-dimensions/notations) (MIT, see `apps/mac/Sources/Margin/Notations.swift`).
