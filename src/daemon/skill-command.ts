/**
 * Skill-declared commands (`!`cmd`` in a SKILL.md) as permission grants
 * (#233, #348): which ones can be granted safely, and how to log one.
 */

/**
 * Split a comma-joined allowed-tools list the way the Claude CLI does
 * (`--allowedTools`, which the SDK builds by joining rules with ","):
 * outside parentheses a comma or space ends a rule. The CLI keeps ONE
 * "inside parens" flag, not a depth — `(` sets it, any `)` clears it — so after
 * an inner `)` a space or comma ends the rule even though the outer `Bash(` is
 * still open. Measured against the bundled CLI (2.1.281).
 */
export function splitAllowedToolsLikeCli(list: string): string[] {
  const out: string[] = [];
  let cur = "";
  let inParens = false;
  for (const ch of list) {
    if (ch === "(") inParens = true;
    else if (ch === ")") inParens = false;
    else if (!inParens && (ch === "," || ch === " ")) {
      if (cur) out.push(cur);
      cur = "";
      continue;
    }
    cur += ch;
  }
  if (cur) out.push(cur);
  return out;
}

/**
 * A skill command that cannot be safely granted as one exact `Bash(<cmd>)`
 * permission rule (#348). The rule also covers the agent's own Bash tool, so:
 *   - `*` is refused — a wildcard (incl. a `:*` prefix rule);
 *   - the rule must survive the CLI's splitter as exactly itself — otherwise
 *     what follows becomes a rule of its own (`a (b) ,Read(/etc/shadow) c`
 *     yields `Read(/etc/shadow)`; `echo (x) Bash ()` yields a bare `Bash`);
 *   - unbalanced parens, and a backslash before a paren (which the CLI may read
 *     as an escape), are refused outright.
 */
export function isUngrantableSkillCommand(command: string): boolean {
  if (command.includes("*") || /\\[()]/.test(command)) return true;
  let depth = 0;
  for (const ch of command) {
    if (ch === "(") depth += 1;
    else if (ch === ")" && --depth < 0) return true;
  }
  if (depth !== 0) return true;
  const rule = `Bash(${command})`;
  const parts = splitAllowedToolsLikeCli(rule);
  return parts.length !== 1 || parts[0] !== rule;
}

/**
 * A skill command for a log or audit line: whole credential-shaped tokens
 * (an `sk-`/`ghp_`/`AKIA` key, a bearer token) replaced, the rest kept so the
 * line still says which command it was.
 */
export function redactCommand(command: string): string {
  return command
    .replace(/(?<![A-Za-z0-9_-])(?:sk-[A-Za-z0-9_-]{20,}|gh[pousr]_[A-Za-z0-9]{20,}|AKIA[A-Z0-9]{16})(?![A-Za-z0-9_-])/g, "«redacted»")
    .replace(/(bearer\s+)[A-Za-z0-9._~+/=-]{16,}/gi, "$1«redacted»");
}

