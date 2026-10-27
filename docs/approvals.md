# Approvals by risk

codeoid decides whether a shell command needs your approval from what the command does, not from the tool's name (#431).
Every shell command an agent wants to run is parsed, wrappers and all, and given a risk level.

## The levels

| Level | Means | Examples |
| --- | --- | --- |
| low | Reads inside the workspace, and nothing else | `git status`, `ls -la`, `grep -rn foo src`, `cat README.md \| head` |
| medium | Changes something, runs code, or reaches outside the workspace | `npm test`, `echo x > out.txt`, `git commit`, `rm -rf build`, `cat /etc/hosts` |
| high | Hard or impossible to undo, or a classic way to lose data or credentials | `rm -rf ~`, `git push --force`, `curl … \| sh`, `echo … >> ~/.bashrc`, `cat ~/.ssh/id_rsa`, `sudo …`, `dd of=/dev/sda` |
| not understood | The command can't be read with certainty | a syntax error, `$CMD -rf x`, `eval "$X"`, `bash -c "$SCRIPT"` |

The parser looks through pipelines, `&&` / `||` / `;` chains, subshells, loops and conditionals, `$(…)` and `<(…)`, here-documents, and wrappers that run another command: `sudo`, `env`, `nice`, `nohup`, `timeout`, `xargs`, `find -exec`, `watch`, `flock`, `eval`, and `bash -c '…'` (and the same for `sh`, `zsh` and the other shells).
`sudo bash -c 'rm -rf /'` is judged as the `rm` it runs, and as running as another user.

Rules over-state rather than under-state: a path that is only known at run time, or relative to a directory outside the workspace, counts as outside it, and a recursive delete of anything that isn't plainly inside the workspace is high.

## What each level does

- **High** asks in every mode, autonomous included, and doesn't use up an autonomous tool budget.
- **Not understood** asks in every mode too, unless you set `approvals.askOnUnknown` to `false`.
- **Low** runs without asking in guarded mode if you set `approvals.autoAllowLowRisk` to `true` (off by default). Never in interactive mode.
- Otherwise each mode does what it always did: guarded asks about every shell command, autonomous runs them within its budget.

A command that names one of codeoid's own credential files, or another agent's login (`~/.codeoid/config.json`, `~/.claude/.credentials.json`, `~/.codex/auth.json`, …), is refused outright, in any mode, as reading the file with a file tool is.
One that searches a directory holding them (`grep -r token ~`) asks.

The approval prompt says the level and why, in the web UI, the terminal UI, Telegram, the line client and `codeoid approve`.

```json
{
  "approvals": {
    "autoAllowLowRisk": false,
    "askOnUnknown": true
  }
}
```

Rewinding uses the same reading of a command for its "not undone by going back" list: it lists commands with effects outside the workspace's files (a push, an install, a write outside the workspace, `sudo`), not every command whose text mentions one.

## Which backends

| Backend | Covered |
| --- | --- |
| Claude | Every shell command, including ones a `permissions.allow` rule in your Claude settings would run unasked: a high-risk or not-understood one is handed to codeoid's gate first. |
| Gemini CLI, pi | Every shell command that asks for approval. |
| Qwen Code | Commands Qwen Code itself judges read-only run without asking codeoid (see CLAUDE.md, "Known gap"); everything else is covered. |
| Codex | Guarded mode only. Its `untrusted` policy runs commands it judges safe without asking; in autonomous mode codeoid runs Codex with no approvals at all, so no command reaches the gate (#442). |
| OpenAI, Gemini API, llama.cpp | These backends have no shell tool. |

## Limits

- The parser judges the command line, not what the programs it runs do: `npm test` runs whatever the project's scripts say, and is medium for that reason; `python3 script.py` is medium, whatever the script does.
- Paths are judged as written. A symlink inside the workspace that points outside it is not seen through.
- A command that reaches the gate is judged; one a backend runs without asking (see the table) is not.
