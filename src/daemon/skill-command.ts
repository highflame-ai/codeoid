/**
 * Skill-declared commands (`!`cmd`` in a SKILL.md) as permission grants
 * (#233, #348): which ones can be granted safely, and how to log one.
 */

/**
 * A skill command that cannot be safely written as one exact `Bash(…)`
 * permission rule — never granted (#348):
 *   - `*` is a wildcard (incl. a `:*` prefix rule) that the agent's own Bash
 *     tool would then match;
 *   - an UNBALANCED `)` closes the rule early, and what follows in the
 *     comma-joined rule list becomes a rule of its own
 *     (`echo ),Read(~/.ssh/id_rsa`). The CLI's splitter tracks paren depth, so
 *     balanced parens — and commas inside them — stay inside the rule
 *     (`--format="table(A,B)"`);
 *   - a backslash before a paren, which the splitter may treat as an escape
 *     and count differently from us.
 */
export function isUngrantableSkillCommand(command: string): boolean {
  if (command.includes("*") || /\\[()]/.test(command)) return true;
  let depth = 0;
  for (const ch of command) {
    if (ch === "(") depth += 1;
    else if (ch === ")") {
      depth -= 1;
      if (depth < 0) return true;
    }
  }
  return depth !== 0;
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

