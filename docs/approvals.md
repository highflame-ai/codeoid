# Approvals by risk

codeoid decides whether a shell command needs your approval from what the command line says it does, not from the tool's name (#431).
Every shell command an agent wants to run is parsed, wrappers and all, and given a risk level.

**The levels are guidance drawn from reading the command line. They are not a sandbox.**
High and not-understood commands ask, and codeoid's credential files are refused when the reader recognises them, but both are a best effort: a command can be written in ways the reader doesn't recognise, and then it is rated medium.
Only "low" is a promise, and it is kept by being a strict allow-list (below): anything unusual simply isn't low.
The real protection for your credentials and for files outside the workspace is running the agent's commands in a sandbox ([#448](https://github.com/highflame-ai/codeoid/issues/448)).

## The levels

| Level | Means | Examples |
| --- | --- | --- |
| low | A plain read inside the workspace, of a shape on the allow-list | `git status`, `ls -la`, `grep -rn foo src \| head`, `cat package.json \| jq .scripts` |
| medium | Everything that isn't low, high or not understood: changes something, runs code, reaches outside the workspace, or isn't a plain read | `npm test`, `echo x > out.txt`, `git commit`, `rm -rf build`, `cat /etc/hosts`, `cd src && ls`, `for f in *.ts; do …; done` |
| high | Hard or impossible to undo, or a classic way to lose data or credentials, as far as the reader can tell | `rm -rf ~`, `git push --force`, `curl … \| sh`, `echo … >> ~/.bashrc`, `cat ~/.ssh/id_rsa`, `sudo …`, `dd of=/dev/sda` |
| not understood | The command can't be read with certainty | a syntax error, `$CMD -rf x`, `eval "$X"`, `bash -c "$SCRIPT"`, `x='a[$(…)]'; echo $((x))` |

## Low is an allow-list

A command line is low only when every simple command in it meets all of these:

- The program is one of a short set of read-only programs, named plainly (not by a path such as `./cat`, and not through a wrapper such as `env`, `time`, `xargs` or `sh -c`): `ls`, `cat`, `head`, `tail`, `wc`, `grep`, `rg`, `ag`, `fd`, `find`, `sed`, `awk`, `jq`, `sort`, `uniq`, `cut`, `tr`, `diff`, `stat`, `du`, `df`, `tree`, `file`, `realpath`, `echo`, `printf`, `test`, `date`, `hostname`, `which` and similar, and `git`'s read subcommands (`status`, `log`, `diff`, `show`, `blame`, `grep`, `ls-files`, a `branch` or `tag` listing, `stash list`, `config --get`, …).
- None of the options that make one of them run another program or write is given: `find -exec`/`-delete`/`-fprint`, `fd -x`/`-X`/`-l`, `rg --pre`/`-z`, `ag --pager`, `sed -i`/`-f` or a script other than plain print and substitute, `awk` with `system`, pipes, redirects, `getline`, `ENVIRON` or options other than `-F`/`-v`, `sort -o`/`-T`, `uniq` or `xxd` with an output file, `tree -o`/`-R`, `printf -v`, `test -v`, `git -c` and every other git global option except `-C` into the workspace, `--no-pager`, `-P`, `--no-optional-locks` and `--literal-pathspecs`, and `git --output`, `--ext-diff`, `--textconv`, `grep -O`.
- Every word is known before the line runs: no `$VAR`, `${…}`, `$(…)`, backticks, arithmetic, process substitution, or here-document that expands anything. A glob is fine only when it stays under a directory in the workspace: no `..`, `~`, braces, brackets, or a wildcard that could match a leading dot.
- No `cd`, `pushd` or `popd` anywhere in the line, and no variable assignment or environment prefix (`LANG=C ls` is medium).
- Every path-like argument (including an option's value, `--file=x`, and the value after `=` in `key=value`) resolves inside the workspace and isn't a credential file.
- No redirect writes, except to `/dev/null`; a descriptor may be duplicated (`2>&1`); a file may be read from inside the workspace.
- The line is made of commands, pipelines, `&&` / `||` / `;` lists, subshells, `{ … }` and `if`. Loops, `case`, functions, `declare`/`export`/`local`, `[[ … ]]` and `(( … ))` aren't low.

So `approvals.autoAllowLowRisk` can't be talked into running something unusual: such a line is medium, and asks.

## How the rest is read

The parser looks through pipelines, `&&` / `||` / `;` chains, subshells, loops and conditionals, `$(…)`, `` `…` `` and `<(…)` (in an unquoted here-document too), here-documents, and wrappers that run another command: `sudo`, `env`, `nice`, `nohup`, `timeout`, `xargs`, `find -exec`, `fd -x`, `watch`, `flock`, `eval`, `trap`, `script -c`, `coproc`, `time`, `busybox`, `alias`, and `bash -c '…'` (and the same for `sh`, `zsh` and the other shells, whatever options come before or after `-c`).
`sudo bash -c 'rm -rf /'` is judged as the `rm` it runs, and as running as another user.
A shell that runs its input (`echo '…' | sh`, `bash /dev/stdin <<< '…'`, `cat <<EOF | bash`) is judged as the script when the line holds it, and is not understood when it doesn't (`… | base64 -d | sh`, `sh < <(…)`).
`time` or `coproc` in front of a compound command (`time { …; }`) is not understood, and what's inside is judged too.

Within what it recognises, the reader over-states rather than under-states:

- A path written with `$HOME`, `~`, or your own `~user` is read as the home directory; `~+` as the current directory.
- A path only known at run time (`cat "$f"`, `cat $(…)`, what `xargs` hands a command) counts as outside the workspace, so a read of it is medium. So does a path relative to a directory outside it, and a `cd` is followed to where it goes.
- A recursive delete of anything that isn't plainly inside the workspace is high, and so is a delete `find` or `xargs` runs on what a search outside the workspace finds.
- Writes to start-up and agent files (`~/.bashrc`, `~/.bash_aliases`, `~/.claude`, `~/.codeoid`, …) and system paths are high when written with a redirect, `cp`/`mv`/`install` (`-t` too), `curl -o`/`wget -O`, `truncate`, `touch`, `tee`, `dd of=`, `sed -i`, `xxd` or `tree -o`, even in a session whose workspace is `~` or `/`. So are `git config --global`, `crontab` and `systemctl enable`.
- A variable that makes programs load or run code (`LD_PRELOAD`, `LD_LIBRARY_PATH`, `GIT_*` such as `GIT_EXTERNAL_DIFF` or `GIT_CONFIG_*`, `BASH_ENV`, `ENV`, `PROMPT_COMMAND`, `PS4`, `CDPATH`, …) makes the line not understood, wherever it's set, `printf -v` and `read` included. One that picks a program or splits words (`PATH`, `PYTHONPATH`, `NODE_OPTIONS`, `HOME`, `IFS`, `EDITOR`, `VISUAL`, `PAGER`, …) is medium, and so is any other variable put in a program's environment.
- Arithmetic on a variable (`$((x))`, `((…))`, `for ((…))`, `let`, `[[ $x -eq 1 ]]`, `${a[$i]}`, `${s:0:n}`, `${!x}`) is medium. It is not understood when the same line sets a variable it reads (directly, or through another variable's name) to text holding `$(`, a backtick or `[`, since bash runs a `$(…)` in a subscript there. `${x@P}` is not understood, and so is a variable name whose subscript holds `$(…)` or a backtick as text (`printf -v 'a[$(…)]'`, `test -v`, `declare`, `unset`, `read`).
- A "read-only" program told to run or write something is medium: `rg --pre`, `awk` with `system()`, `sed -i`, `git ls-remote`, `git grep -O`, `sort --compress-program`, `jq env`.

## What each level does

- **High** asks in every mode, autonomous included, and doesn't use up an autonomous tool budget.
- **Not understood** asks in every mode too, unless you set `approvals.askOnUnknown` to `false`. A command nothing could be read of (the parser isn't loaded, the line is over 100,000 characters, the tool call holds no command) asks whatever that setting says.
- **Low** runs without asking in guarded mode if you set `approvals.autoAllowLowRisk` to `true` (off by default). Never in interactive mode.
- Otherwise each mode does what it always did: guarded asks about every shell command, autonomous runs them within its budget. Medium runs unasked in autonomous mode, and on Claude a `permissions.allow` rule in your Claude settings runs it unasked too.

A command that names one of codeoid's own credential files, or another agent's login (`~/.codeoid/config.json`, `~/.claude/.credentials.json`, `~/.codex/auth.json`, …), in a way the reader recognises, is refused, in any mode, as reading the file with a file tool is.
That includes a file a wrapper reads itself (`xargs -a FILE`), and `ps` showing processes' environments (`ps eww`, `ps auxe`, macOS's `ps -E`, an `env` field), which reads every same-user process's `/proc/<pid>/environ` itself: the daemon's keys, a backend server's password. A plain `ps` (`ps aux`, `ps -ef`) stays medium.
One that searches a directory holding them (`grep -r token ~`) asks.
Spellings the reader doesn't follow are medium instead (see Limits).

The approval prompt says the level and why, in the web UI, the terminal UI, Telegram, the line client and `codeoid approve`.

```json
{
  "approvals": {
    "autoAllowLowRisk": false,
    "askOnUnknown": true
  }
}
```

Rewinding uses the same reading of a command for its "not undone by going back" list: it lists commands with effects outside the workspace's files (a push, an install, a write outside the workspace, `sudo`), not every command whose text mentions one. A command is read in the directory it ran in, as the gate read it: one opencode ran with a `workdir` outside the workspace is listed when it writes there, and one in a directory opencode couldn't resolve for certain is judged in each place it may have run.

## Which backends

| Backend | Covered |
| --- | --- |
| Claude | Every shell command, including ones a `permissions.allow` rule in your Claude settings would run unasked: a high-risk or not-understood one is handed to codeoid's gate first. A medium one still runs on such a rule. |
| Gemini CLI, pi | Every shell command that asks for approval. |
| Qwen Code | Commands Qwen Code itself judges read-only run without asking codeoid (see CLAUDE.md, "Known gap"); everything else is covered. |
| opencode | Every shell command, its subagents' too, judged in the directory the call names (`workdir`); where that directory can't be resolved for certain, the call is asked in every mode and its command judged in each place it may lead. A line with no command in it (only `cd`, assignments, `export` / `unset` / `readonly`, comments) runs without asking, as opencode 2.2.5 runs it: it can't act outside its own shell, and rates medium at most ([docs/opencode.md](opencode.md)). |
| Codex | Guarded mode only. Its `untrusted` policy runs commands it judges safe without asking; in autonomous mode codeoid runs Codex with no approvals at all, so no command reaches the gate (#442). |
| OpenAI, Gemini API, llama.cpp | These backends have no shell tool. |

## Limits

These are the ways a command gets past "high" or "refused" and is rated **medium**, so it runs unasked in autonomous mode (and on a Claude allow rule). None of them is low.

- **A `cd` is followed as if it happened.** A `cd` that fails, or runs in a subshell, `$(…)` or behind `false &&`, still moves the paths after it: `cd nowhere 2>/dev/null; cat ../.codeoid/config.json` from a workspace under `~` is medium, not refused, and the same shape writes `../.bashrc` or deletes `../Documents` at medium.
- **Paths are judged as written.** A symlink inside the workspace that points outside it is not seen through. Another user's `~name`, `~-`, `/proc/$$/…`, a `file://` URL, `dd if=`, an attached option value (`tar -C/x`) and option values a downloader reads (`wget -e`, `curl --variable`, `curl -K`) aren't matched against the credential files.
- **Globs over credential files** (`cat ~/.ssh/id_*`, `cat ~/.codeoid/c*`) are judged by their fixed directory: medium (codeoid's own files ask), not high or refused.
- **Programs and builtins the reader doesn't model** run what they're given unseen: `fakeroot`, `ssh-agent`, `tmux`, `screen`, `vim -c`, `gdb -ex`, `git -c alias.x='!…'` and similar are "runs X", medium. A variable can be set in ways that aren't assignments (`declare -n`, `${X:=…}`), so a steering variable set that way is medium, not not-understood.
- **Writes through programs not modelled as writers** (`sort -o`, `uniq IN OUT`, `git diff --output=`, `find -fprintf`, `tar -x -C`, `unzip -d`, `patch`, `split`, sed's `w`) are medium wherever they write, start-up files included. `rsync --remove-source-files` is judged by its target, not the files it deletes, and moving a directory from outside the workspace into it (`mv ~/Documents ./x`) is medium.
- **Arithmetic on a value from outside the line** (the environment, a file `read` reads, a `$(…)` whose output isn't known) is medium, though bash would run a `$(…)` such a value holds in a subscript.
- **What a program does is not read**: `npm test` runs whatever the project's scripts say, `python3 script.py` and inline code (`python3 -c '…'`, `node -e '…'`) are medium whatever they do. A git read runs what the repository's own config names (`core.fsmonitor`, a diff driver, a pager), and the shell may have functions, aliases or a `PATH` from its start-up the line doesn't show.
- A `CDPATH` set in the environment the shell inherits, not on the line, isn't seen: `cd name` is judged as `./name`.
- A command that reaches the gate is judged; one a backend runs without asking (see the table) is not.
