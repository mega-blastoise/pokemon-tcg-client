# @johto-ai/tcg-chat (TUI)

Conversational card search in the terminal. One Ink app, two runtime entries:

| bin | runtime | client adapter |
| --- | --- | --- |
| `dist/bun.js` (`tcg-chat-bun`) | Bun ≥ 1.4.3 | `bun:sqlite` |
| `dist/node.js` (`tcg-chat-node`) | Node ≥ 24.6 | `node:sqlite` (experimental warning suppressed) |

```sh
bun run chat                         # interactive
bun run chat -- --doctor             # contract checks, exit 1 on failure
node apps/cli/dist/node.js -p "Which Charizard ex cards exist?"
```

Commands: `/doctor`, `/card <id>`, `/find <name>`, `/sets [name]`, `/clear`, `/help`, `/exit`. Esc stops a turn, ↑/↓ recalls history, and Tab accepts Claude's suggested follow-up. `/card`, `/find`, and `/sets` go straight to the client without the model, so each layer can be checked on its own.

Options: `--snapshot <dir>` (or `TCG_SNAPSHOT_DIR`), `--model <name>` (or `TCG_MODEL`). Without `--snapshot` it uses the newest `.local/catalog-check-*/first` build, then the installed `@johto-ai/tcg-data`. Draft snapshots are allowed because this is a maintainer tool.
