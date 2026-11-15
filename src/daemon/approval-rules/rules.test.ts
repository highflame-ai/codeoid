import { beforeAll, describe, expect, test } from "bun:test";
import { homedir } from "node:os";
import { commandCoverage } from "../risk/shell-risk.js";
import { loadShellParser, parseShellSync } from "../shell/parse.js";
import { fetchHostOf, formatRule, type MatchableRule, parseRule, proposeShellRules, proposeToolRule, shellLineVerdict, toolRuleMatch } from "./rules.js";

const WS = "/work/repo";
const CTX = { cwd: WS, workdir: WS, configDir: `${homedir()}/.codeoid` };

beforeAll(async () => {
  await loadShellParser();
});

function rule(text: string, effect: "allow" | "deny" = "allow"): MatchableRule {
  const p = parseRule(text);
  if (!p.ok) throw new Error(`${text}: ${p.error}`);
  return { id: text, pattern: p.pattern, effect, scope: "repository" };
}

function verdict(line: string, rules: MatchableRule[], cwd = WS) {
  const parsed = parseShellSync(line);
  return shellLineVerdict(parsed, commandCoverage(line, parsed, { ...CTX, cwd }), rules);
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
    ["git commit -m 'fix: x'", ["Bash(git commit:*)"]],
    ["rm -rf build", ["Bash(rm -rf build)"]],
    ["python3 -m pytest", ["Bash(python3 -m pytest)"]],
    ["npm test 2>&1 | tail -50", ["Bash(npm test:*)"]],
    ["make lint && npm test", ["Bash(make lint:*)", "Bash(npm test:*)"]],
    ["npm test -- $FILE", ["Bash(npm test:*)"]],
    ["cd sub && npm run build", ["Bash(npm run:*)"]],
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
    ["echo 'a b' > /dev/null; ./run.sh \"a b\""],
    ["python3 -c 'print(1)'"],
    ["git status"],
  ])("%s offers nothing", (line) => {
    expect(propose(line)).toBeNull();
  });

  test("what a rule already covers isn't offered again", () => {
    expect(propose("make lint && npm test", [rule("Bash(npm test:*)")])).toEqual(["Bash(make lint:*)"]);
  });
});

describe("non-shell rules", () => {
  const rules = [rule("mcp__linear__list_issues"), rule("WebFetch(domain:docs.rs)"), rule("WebFetch(domain:evil.example)", "deny")];

  test("an MCP tool by its exact name", () => {
    expect(toolRuleMatch("mcp__linear__list_issues", {}, rules)?.effect).toBe("allow");
    expect(toolRuleMatch("mcp__linear__create_issue", {}, rules)).toBeNull();
  });

  test("a fetch by its exact host", () => {
    expect(toolRuleMatch("WebFetch", { url: "https://docs.rs/serde" }, rules)?.effect).toBe("allow");
    expect(toolRuleMatch("WebFetch", { url: "https://sub.docs.rs/x" }, rules)).toBeNull();
    expect(toolRuleMatch("WebFetch", { url: "https://docs.rs.evil.example/x" }, rules)).toBeNull();
    expect(toolRuleMatch("WebFetch", { url: "https://user:pw@docs.rs/x" }, rules)).toBeNull();
    expect(toolRuleMatch("WebFetch", { url: "file:///etc/passwd" }, rules)).toBeNull();
    expect(toolRuleMatch("WebFetch", { url: "https://evil.example/" }, rules)?.effect).toBe("deny");
  });

  test("hosts read as URL reads them", () => {
    expect(fetchHostOf({ url: "https://DOCS.rs:443/x" })).toBe("docs.rs");
    expect(fetchHostOf({ url: "not a url" })).toBeNull();
    expect(fetchHostOf({ prompt: "https://docs.rs" })).toBeNull();
  });

  test("offers", () => {
    expect(proposeToolRule("WebFetch", { url: "https://docs.rs/x" })).toEqual({ tool: "WebFetch", host: "docs.rs" });
    expect(proposeToolRule("mcp__linear__list_issues", {})).toEqual({ tool: "mcp", name: "mcp__linear__list_issues" });
    expect(proposeToolRule("Edit", { file_path: "x" })).toBeNull();
  });
});
