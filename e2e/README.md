# End-to-end tests

Whole user journeys against a real daemon, with real clients: the web UI in Chromium and the CLI.
No model runs: the **scripted backend** replays a written conversation instead, so the suite needs no credentials and gives the same result every time.

```bash
bun run build:web            # the suite serves the built web UI
bunx playwright install chromium   # once
bun run test:e2e             # all specs
bun run test:e2e -- approvals      # one file
bun run test:e2e -- --headed --workers 1   # watch it
```

A failing test keeps its trace, a screenshot and the daemon's log under `test-results/` (`bunx playwright show-trace <trace.zip>`).
CI runs the suite on every PR (the `e2e` job in `.github/workflows/pr-check.yml`) and uploads those on failure.

## What a test gets

Each test boots its own daemon (`e2e/harness.ts`):

- `codeoid start --local` on a free port, from source;
- a throwaway home, config dir (`XDG_CONFIG_HOME`) and git workdir, so nothing touches your own `~/.codeoid`, `~/.claude` or keys;
- the scripted backend as the default, and every other backend that would need a binary or the network turned off, with memory off (it would download a model).

The `codeoid` fixture gives the test:

| | |
|---|---|
| `codeoid.setScript(rules)` | what the backend does next (read again on every turn) |
| `codeoid.workdir`, `readFile(path)` | the session's git repo |
| `codeoid.cli(...args)`, `cliOk(...args)` | run the CLI against this daemon |
| `codeoid.restart()` | stop (SIGTERM) and start the daemon again; the local token is pinned, so open pages reconnect |
| `codeoid.uiUrl`, `log` | the web UI's address; the daemon's output (attached to a failing test) |

Helpers for the web UI: `openUi`, `createSessionInUi`, `focusSession`, `send`, `messages`, `setMode`, `waitIdle`.
Prefer roles and visible text over CSS: a spec should read like what a user does and sees.

## The scripted backend

`src/daemon/providers/scripted/` — registered only when `CODEOID_E2E_SCRIPT` names a script, so a normal install never offers it.
A script is a list of rules; the first whose `match` (a regular expression) finds the user's message runs its steps, and a message no rule matches gets `scripted: <message>`.

```json
{ "rules": [
  { "match": "^write it", "steps": [
    { "text": "Writing." },
    { "tool": "Write", "input": { "file_path": "a.txt", "content": "hi\n" } },
    { "sleep": 500 },
    { "text": "Done." },
    { "usage": { "inputTokens": 100, "outputTokens": 20, "costUsd": 0.01 } }
  ] },
  { "match": "^break", "steps": [ { "error": "upstream failed" } ] }
] }
```

Every tool call goes through the session's real approval gate, so modes, approvals, the autonomous budget and the audit log behave as they do with a model.
An allowed `Write` really writes (inside the workdir only), so checkpoints, rewind and fork have files to restore; any other tool returns its `output` without running anything.

## Adding a journey

1. Write the rules for what the backend should do.
2. Write the spec in `e2e/specs/`: drive the UI or CLI, and assert what a user would see and what's on disk.
3. Run it a few times (`--repeat-each 5`): a flaky end-to-end test is a bug to fix, and the suite has no retries to hide one.
