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

The parser looks through pipelines, `&&` / `||` / `;` chains, subshells, loops and conditionals, `$(…)`, `` `…` `` and `<(…)` (in an unquoted here-document too), here-documents, and wrappers that run another command: `sudo`, `env`, `nice`, `nohup`, `timeout`, `xargs`, `find -exec`, `fd -x`, `watch`, `flock`, `eval`, `trap`, `script -c`, `coproc`, `busybox`, `alias`, and `bash -c '…'` (and the same for `sh`, `zsh` and the other shells, whatever options come before or after `-c`).
`sudo bash -c 'rm -rf /'` is judged as the `rm` it runs, and as running as another user.
A shell that runs its input is judged as the script when the line holds it (`echo '…' | sh`, `cat <<EOF | bash`), and is not understood when it doesn't (`… | base64 -d | sh`, `sh < <(…)`).

Rules over-state rather than under-state:

- A path written with `$HOME` is read as the same path with `~`.
- A path only known at run time (`cat "$f"`, `cat $(…)`, what `xargs` hands a command) counts as outside the workspace, so a read of it is medium. So does a path relative to a directory outside it, and a `cd` is followed to where it goes.
- A recursive delete of anything that isn't plainly inside the workspace is high, and so is a delete `find` or `xargs` runs on what a search outside the workspace finds.
- Writes to start-up and agent files (`~/.bashrc`, `~/.bash_aliases`, `~/.claude`, `~/.codeoid`, …) and system paths are high however they're written (a redirect, `cp -t`, `curl -o`, `truncate`, `tee`), even in a session whose workspace is `~` or `/`. So are `git config --global`, `crontab` and `systemctl enable`.
- A variable that steers what a program runs or where paths point (`PATH`, `LD_PRELOAD`, `GIT_*`, `PAGER`, `BASH_ENV`, `HOME`, `CDPATH`, …) makes the line not understood, wherever it's set; any other variable put in a program's environment (`FOO=1 cmd`, `export FOO=1`) makes it medium.
- Arithmetic on a variable (`$((x))`, `[[ $x -eq 1 ]]`, `${a[$i]}`) and `${x@P}` are not understood: bash runs a `$(…)` the value holds.
- A "read-only" program told to run or write something is medium: `rg --pre`, `awk` with `system()`, `sed -i`, `git ls-remote`, `git grep -O`, `sort --compress-program`, `jq env`.

## What each level does

- **High** asks in every mode, autonomous included, and doesn't use up an autonomous tool budget.
- **Not understood** asks in every mode too, unless you set `approvals.askOnUnknown` to `false`. A command nothing could be read of (the parser isn't loaded, the line is over 100,000 characters, the tool call holds no command) asks whatever that setting says.
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
- Code an interpreter is handed inline (`python3 -c '…'`, `node -e '…'`, `python3 - <<EOF`) is medium, as `python3 script.py` is: it is code, not a command line the parser can read.
- A path only known at run time can't be checked against codeoid's credential files: it is medium, not refused. After a `cd` to somewhere only known at run time (`cd -`, `cd "$D"`), a relative name that would be a credential file in any credential directory asks.
- A `CDPATH` set in the environment the shell inherits, not on the line, isn't seen: `cd name` is judged as `./name`.
- A command that reaches the gate is judged; one a backend runs without asking (see the table) is not.
