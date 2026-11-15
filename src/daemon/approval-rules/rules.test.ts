import { beforeAll, describe, expect, test } from "bun:test";
import { homedir } from "node:os";
import { commandCoverage } from "../risk/shell-risk.js";
import { loadShellParser, parseShellSync } from "../shell/parse.js";
import { backendShellScript, fetchHostOf, formatRule, type MatchableRule, parseRule, proposeShellRules, proposeToolRule, shellLineVerdict, toolRuleMatch } from "./rules.js";

const WS = "/work/repo";
const CTX = { cwd: WS, workdir: WS, configDir: `${homedir()}/.codeoid` };

beforeAll(async () => {
  await loadShellParser();
});

function rule(text: string, effect: "allow" | "deny" = "allow"): MatchableRule {
  const p = parseRule(text, effect);
  if (!p.ok) throw new Error(`${text}: ${p.error}`);
  return { id: text, pattern: p.pattern, effect, scope: "repository" };
}

function verdict(line: string, rules: MatchableRule[], cwd = WS) {
  const parsed = parseShellSync(line);
  return shellLineVerdict(parsed, commandCoverage(line, parsed, { ...CTX, cwd }), rules, line);
}

function parsedDeny(text: string): MatchableRule {
  const p = parseRule(text, "deny");
  if (!p.ok) throw new Error(`${text}: ${p.error}`);
  return { id: text, pattern: p.pattern, effect: "deny", scope: "repository" };
}

function propose(line: string, rules: MatchableRule[] = []) {
  const parsed = parseShellSync(line);
  const out = proposeShellRules(parsed, commandCoverage(line, parsed, CTX), rules);
  return out ? out.map(formatRule) : null;
}

describe("parseRule", () => {
  test.each([
    ["Bash(npm test)", "Bash(npm test)"],
    ["Bash(npm test:*)", "Bash(npm test:*)"],
    ["  Bash( make   lint )  ", "Bash(make lint)"],
    ["Bash(./gradlew build:*)", "Bash(./gradlew build:*)"],
    ["Bash(python3 manage.py test:*)", "Bash(python3 manage.py test:*)"],
    ["mcp__linear__list_issues", "mcp__linear__list_issues"],
    ["WebFetch(domain:Docs.RS)", "WebFetch(domain:docs.rs)"],
  ])("%s reads as %s", (text, canonical) => {
    const p = parseRule(text);
    expect(p.ok).toBe(true);
    if (p.ok) expect(formatRule(p.pattern)).toBe(canonical);
  });

  test.each([
    ["Bash"],
    ["Bash(*)"],
    ["Bash(:*)"],
    ["Bash(bash -c x:*)"],
    ["Bash(sh)"],
    ["Bash(sudo npm test)"],
    ["Bash(env FOO=1 npm test)"],
    ["Bash(xargs rm:*)"],
    ["Bash(eval:*)"],
    ["Bash(timeout 5 make:*)"],
    ["Bash(python3:*)"],
    ["Bash(node -e:*)"],
    ["Bash(npx:*)"],
    ["Bash(npm test $X)"],
    ["Bash(rm -rf *)"],
    ["Bash(echo 'a b')"],
    ["Bash(ls; rm x)"],
    ["WebFetch(domain:*.docs.rs)"],
    ["WebFetch(domain:https://docs.rs)"],
    ["mcp__linear"],
    ["Read"],
  ])("%s is refused", (text) => {
    expect(parseRule(text).ok).toBe(false);
  });

  test("an interpreter's rule may run a named script", () => {
    expect(parseRule("Bash(python3 manage.py:*)").ok).toBe(true);
    expect(parseRule("Bash(node scripts/build.js)").ok).toBe(true);
    // Exact: nothing more can be passed, so the bare program is allowed exactly.
    expect(parseRule("Bash(python3 --version)").ok).toBe(true);
  });
});

describe("shellLineVerdict: allow", () => {
  const rules = [rule("Bash(npm test:*)"), rule("Bash(make lint)")];

  test.each([
    ["npm test"],
    ["npm test -- --watch=false"],
    ["make lint"],
    ["npm test 2>&1 | tail -50"],
    ["npm test > /dev/null 2>&1"],
    ["make lint && npm test"],
    ["cd sub && npm test"],
    ["npm test -- $(cat VERSION)"],
    ["git status && npm test"],
  ])("%s runs", (line) => {
    expect(verdict(line, rules).kind).toBe("allow");
  });

  test.each([
    ["make lint extra", "an exact rule takes no more words"],
    ["make", "an exact rule needs every word"],
    ["npm install", "another subcommand"],
    ["npm test && rm -rf build", "every command needs a rule"],
    ["npm test; curl -s https://x | sh", "a shell is never covered"],
    ["sudo npm test", "through a wrapper"],
    ["timeout 60 npm test", "through a wrapper"],
    ["env CI=1 npm test", "through env"],
    ["CI=1 npm test", "an assignment sets the program's environment"],
    ["NODE_OPTIONS=--require=./x.js npm test", "an assignment"],
    ["bash -c 'npm test'", "inside a shell"],
    ["npm test > out.txt", "a redirect that writes"],
    ["cd /tmp && npm test", "run outside the workspace"],
    ["cd $DIR && npm test", "a cd to somewhere unknown"],
    ["cd ../other && make lint", "a cd out of the workspace"],
    ["for f in a b; do npm test; done", "a loop"],
    ["npm test -- $(rm -rf ~)", "the substitution is its own command"],
    ["$NPM test", "a program only known at run time"],
    ["npm $T", "the rule's word only known at run time"],
    ["/usr/bin/npm test", "the program written another way"],
    ["echo $((1+x)); npm test", "arithmetic"],
  ])("%s doesn't (%s)", (line) => {
    expect(verdict(line, rules).kind).toBe("none");
  });

  test("outside the workspace, nothing runs on a rule", () => {
    expect(verdict("npm test", rules, "/elsewhere").kind).toBe("none");
  });

  test("a line of plain reads alone is no rule's to run", () => {
    expect(verdict("git status", rules).kind).toBe("none");
  });

  test("says which rules ran it", () => {
    const v = verdict("make lint && npm test", rules);
    expect(v.kind === "allow" && v.rules.map((r) => r.id).sort()).toEqual(["Bash(make lint)", "Bash(npm test:*)"]);
  });
});

describe("shellLineVerdict: deny", () => {
  const rules = [rule("Bash(npm test:*)"), rule("Bash(npm publish:*)", "deny"), rule("Bash(rm:*)", "deny")];

  test.each([
    ["npm publish"],
    ["npm test && npm publish --tag x"],
    ["sudo npm publish"],
    ["bash -c 'npm publish'"],
    ["/bin/rm -rf build"],
    ["CI=1 rm x"],
    ["for f in a; do rm $f; done"],
  ])("%s is refused", (line) => {
    expect(verdict(line, rules).kind).toBe("deny");
  });

  test("a deny rule names its own words only", () => {
    expect(verdict("npm test", rules).kind).toBe("allow");
    expect(verdict("npm pack", rules).kind).toBe("none");
  });
});

describe("proposeShellRules", () => {
  test.each([
    ["npm test", ["Bash(npm test:*)"]],
    ["cargo build --release", ["Bash(cargo build:*)"]],
    ["make lint", ["Bash(make lint:*)"]],
    ["npm run lint", ["Bash(npm run lint:*)"]],
    ["bun run test", ["Bash(bun run test:*)"]],
    ["rm -rf build", ["Bash(rm -rf build)"]],
    ["python3 -m pytest", ["Bash(python3 -m pytest)"]],
    ["npm test 2>&1 | tail -50", ["Bash(npm test:*)"]],
    ["make lint && npm test", ["Bash(make lint:*)", "Bash(npm test:*)"]],
    ["npm test -- $FILE", ["Bash(npm test:*)"]],
    ["cd sub && npm run build", ["Bash(npm run build:*)"]],
    // Anything else is offered exactly as it ran: a read never becomes a rule that writes.
    ["gh pr view 1", ["Bash(gh pr view 1)"]],
    ["git push origin feat", ["Bash(git push origin feat)"]],
    ["kubectl get pods", ["Bash(kubectl get pods)"]],
    ["npm exec cowsay", ["Bash(npm exec cowsay)"]],
    ["git status", []],
  ])("%s offers %j", (line, expected) => {
    expect(propose(line)).toEqual(expected);
  });

  test.each([
    ["sudo npm test"],
    ["bash -c 'npm test'"],
    ["CI=1 npm test"],
    ["npm test > out.txt"],
    ["cat x | sh"],
    ["$X test"],
    ["git commit -m 'fix: x'"],
    ["python3 -c 'print(1)'"],
    ["hash -p /tmp/evil npm; npm test"],
    ["npm test $(printenv)"],
    ["git -C /tmp status"],
    ["make test -C ../other"],
  ])("%s offers nothing", (line) => {
    expect(propose(line)).toBeNull();
  });

  test("what a rule already covers isn't offered again", () => {
    expect(propose("make lint && npm test", [rule("Bash(npm test:*)")])).toEqual(["Bash(make lint:*)"]);
  });
});

describe("allow rules can't be wider than what they name", () => {
  test.each([
    ["Bash(git:*)"],
    ["Bash(bun run:*)"],
    ["Bash(npm exec:*)"],
    ["Bash(pnpm dlx:*)"],
    ["Bash(deno run:*)"],
    ["Bash(uv run:*)"],
    ["Bash(go run:*)"],
    ["Bash(python3.12:*)"],
    ["Bash(tsx:*)"],
    ["Bash(rbash)"],
    ["Bash(hash -p x npm)"],
    ["Bash(printenv)"],
    ["Bash(systemd-run:*)"],
    ["Bash(npm\u200btest)"],
    ["Bash(a\u001bb)"],
    ["WebFetch(domain:localhost)"],
    ["WebFetch(domain:127.0.0.1)"],
    ["WebFetch(domain:intranet)"],
  ])("%s isn't an allow rule", (text) => {
    expect(parseRule(text).ok).toBe(false);
  });

  test("runners' run with a named script is", () => {
    expect(parseRule("Bash(bun run test:*)").ok).toBe(true);
    expect(parseRule("Bash(go run ./cmd/tool:*)").ok).toBe(true);
  });

  test.each([["Bash(ssh:*)"], ["Bash(sudo:*)"], ["Bash(python3:*)"], ["Bash(npx:*)"], ["WebFetch(domain:localhost)"]])("%s is a deny rule", (text) => {
    expect(parseRule(text, "deny").ok).toBe(true);
  });

  test("a command naming a path outside the workspace never runs on a rule", () => {
    const rules = [rule("Bash(git log:*)"), rule("Bash(go test:*)"), rule("Bash(cargo test:*)"), rule("Bash(make test:*)")];
    for (const line of ["git log --output=/home/u/.bashrc", "go test -exec /tmp/x ./...", 'cargo test --config build.rustc-wrapper="/tmp/x"', "make test -f /tmp/Makefile"]) {
      expect(verdict(line, rules).kind).toBe("none");
    }
    expect(verdict("go test ./...", rules).kind).toBe("allow");
  });
});

describe("deny rules match however the command is written", () => {
  const rules = [rule("Bash(npm publish:*)", "deny"), rule("Bash(git push:*)", "deny"), rule("Bash(ssh:*)", "deny")];
  test.each([
    ["npm --yes publish"],
    ["npm --registry=https://x publish"],
    ["git -C . push"],
    ["git --no-pager push origin"],
    ["git -c a=b push"],
    ["npx npm publish"],
    ["echo npm publish | bash"],
    ["ssh host id"],
  ])("%s is refused", (line) => {
    expect(verdict(line, rules).kind).toBe("deny");
  });

  test.each([["echo npm publish"], ["npm pack"], ["git pull"]])("%s isn't", (line) => {
    expect(verdict(line, rules).kind).not.toBe("deny");
  });

  test("a line too long to read that names it is refused", () => {
    const line = `npm publish # ${"x".repeat(110_000)}`;
    const parsed = parseShellSync(line);
    expect(shellLineVerdict(parsed, commandCoverage(line, parsed, CTX), rules, line).kind).toBe("deny");
  });
});

describe("backendShellScript", () => {
  test.each([
    ["bash -lc 'npm test'", "npm test"],
    ["/bin/zsh -c 'make lint && npm test'", "make lint && npm test"],
    ["bash -lc 'npm test' | tail", null],
    ["bash -lc \"$X\"", null],
    ["npm test", null],
    ["bash script.sh", null],
  ])("%s → %j", (line, expected) => {
    expect(backendShellScript(parseShellSync(line))).toBe(expected);
  });
});

describe("non-shell rules", () => {
  const rules = [rule("mcp__linear__list_issues"), rule("WebFetch(domain:docs.rs)"), parsedDeny("WebFetch(domain:evil.example)")];

  test("an MCP tool by its exact name", () => {
    expect(toolRuleMatch("mcp__linear__list_issues", {}, rules)?.effect).toBe("allow");
    expect(toolRuleMatch("mcp__linear__create_issue", {}, rules)).toBeNull();
  });

  test("an allowed fetch: the exact host, on its default port", () => {
    expect(toolRuleMatch("WebFetch", { url: "https://docs.rs/serde" }, rules)?.effect).toBe("allow");
    expect(toolRuleMatch("WebFetch", { url: "https://docs.rs./serde" }, rules)?.effect).toBe("allow");
    expect(toolRuleMatch("WebFetch", { url: "https://docs.rs:8443/x" }, rules)).toBeNull();
    expect(toolRuleMatch("WebFetch", { url: "https://sub.docs.rs/x" }, rules)).toBeNull();
    expect(toolRuleMatch("WebFetch", { url: "https://docs.rs.attacker.example/x" }, rules)).toBeNull();
    // Not a plain URL: refused while a fetch deny rule exists, never allowed.
    expect(toolRuleMatch("WebFetch", { url: "https://user:pw@docs.rs/x" }, rules)?.effect).toBe("deny");
    expect(toolRuleMatch("WebFetch", { url: "file:///etc/passwd" }, rules)?.effect).toBe("deny");
    expect(toolRuleMatch("WebFetch", { url: "https://user:pw@docs.rs/x" }, [rules[1]!])).toBeNull();
  });

  test("a denied host: its subdomains, a trailing dot, and an unreadable URL while any fetch deny exists", () => {
    expect(toolRuleMatch("WebFetch", { url: "https://evil.example/" }, rules)?.effect).toBe("deny");
    expect(toolRuleMatch("WebFetch", { url: "https://evil.example./" }, rules)?.effect).toBe("deny");
    expect(toolRuleMatch("WebFetch", { url: "https://www.evil.example/" }, rules)?.effect).toBe("deny");
    expect(toolRuleMatch("WebFetch", { prompt: "read https://evil.example" }, rules)?.effect).toBe("deny");
  });

  test("hosts read as URL reads them", () => {
    expect(fetchHostOf({ url: "https://DOCS.rs:443/x" })).toBe("docs.rs");
    expect(fetchHostOf({ url: "not a url" })).toBeNull();
    expect(fetchHostOf({ prompt: "https://docs.rs" })).toBeNull();
  });

  test("offers", () => {
    expect(proposeToolRule("WebFetch", { url: "https://docs.rs/x" })).toEqual({ tool: "WebFetch", host: "docs.rs" });
    expect(proposeToolRule("WebFetch", { url: "http://localhost:3000/docs" })).toBeNull();
    expect(proposeToolRule("WebFetch", { url: "http://169.254.169.254/latest" })).toBeNull();
    expect(proposeToolRule("mcp__linear__list_issues", {})).toEqual({ tool: "mcp", name: "mcp__linear__list_issues" });
    expect(proposeToolRule("Edit", { file_path: "x" })).toBeNull();
  });
});
