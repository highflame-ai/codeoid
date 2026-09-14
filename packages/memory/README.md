# @highflame/codeoid-memory

Verbatim, workspace-scoped memory for AI coding agents, as an MCP server any
harness can mount.

Episodes are stored **whole** — every tool call, result, and reasoning block, as
it happened — not summarized into extracted "facts". Recall is hybrid: vector
similarity, FTS5/BM25 keyword match, recency, and path overlap with the files
you're touching.

## Use it

Nothing to sign up for, no API key, no daemon:

```bash
claude mcp add codeoid-memory -- npx -y @highflame/codeoid-memory
```

Codex, Cursor, Windsurf and anything else that mounts an MCP server over stdio
take the same command. Then ask the agent to `recall` what an earlier session
learned.

Runs on Node >= 22.5 (uses the built-in `node:sqlite`) or on Bun.

## Tools

| Tool | What it answers |
|---|---|
| `recall` | "What do we already know about X?" — hybrid-ranked episodes |
| `recall_file` | "What happened to this file before?" |
| `timeline` | "What did the last session actually do?" |
| `get_episode` | The full, unabridged episode by id |

## Options

```
--workspace <path>   Directory memories are scoped to (default: cwd)
--db <path>          SQLite file (default: ~/.codeoid/memory.db)
--account <id>       Tenant account id (default: personal)
--project <id>       Tenant project id (default: dev)
```

Memory is anchored on the git **common** dir, so every worktree of a repo shares
one memory — a fix learned on one branch is recallable from the others.

## Writing memory

This server **reads**. The episodes come from
[codeoid](https://github.com/highflame-ai/codeoid), which records every session
turn verbatim as it runs; point `--db` at the same file (the default already is)
and everything codeoid captured is recallable from your editor.

## Library use

```ts
import { createMemory, workspaceIdFromPath } from "@highflame/codeoid-memory";

const engine = await createMemory({ dbPath: "~/.codeoid/memory.db" });
await engine.init();
const hits = await engine.recall({ workspaceId, text: "why did we drop the retry cap?" });
```

Ships TypeScript source for library consumers (Bun, Vite, Metro transpile it);
the `codeoid-memory` bin is a prebuilt Node bundle.

MIT.
