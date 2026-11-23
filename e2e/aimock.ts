/**
 * Real backends against aimock (docs/release-gate.md, tier 2): each backend's
 * own harness (the Claude Code CLI, Codex) runs inside a real daemon and talks
 * to a local aimock server instead of its vendor's API. No credentials, no
 * spend, deterministic. Each test starts its own aimock, so tests can run in
 * parallel.
 */
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { LLMock } from "@copilotkit/aimock";

/** One backend: how it's pointed at aimock, and how its model would write a file. */
export interface AimockBackend {
  id: string;
  /** Why it can't run here (its CLI isn't installed), or null. */
  missing(): string | null;
  /** Environment for the daemon. */
  env(url: string): Record<string, string>;
  /** Its own config under the test's home, if it reads one. */
  home?(home: string, url: string): void;
  /** The API path its requests go to. */
  wirePath: RegExp;
  /** The tool call its model makes to write `content` to `path`. */
  writeFile(path: string, content: string, workdir: string): { name: string; arguments: string };
}

const onPath = (bin: string): boolean => (process.env.PATH ?? "").split(":").some((d) => d && existsSync(join(d, bin)));

export const BACKENDS: AimockBackend[] = [
  {
    id: "claude",
    missing: () => null, // the Agent SDK bundles its CLI
    env: (url) => ({ ANTHROPIC_BASE_URL: url, ANTHROPIC_API_KEY: "aimock-not-a-key", CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1", DISABLE_AUTOUPDATER: "1" }),
    wirePath: /^\/v1\/messages/,
    writeFile: (path, content) => ({ name: "Write", arguments: JSON.stringify({ file_path: path, content }) }),
  },
  {
    id: "codex",
    missing: () => (onPath("codex") ? null : "the codex CLI isn't on PATH"),
    env: () => ({ OPENAI_API_KEY: "aimock-not-a-key" }),
    // Codex reads its model provider from ~/.codex/config.toml.
    home: (home, url) => {
      mkdirSync(join(home, ".codex"), { recursive: true });
      writeFileSync(
        join(home, ".codex", "config.toml"),
        [
          'model = "gpt-5.5"',
          'model_provider = "aimock"',
          "[model_providers.aimock]",
          'name = "aimock"',
          `base_url = "${url}/v1"`,
          'wire_api = "responses"',
          'env_key = "OPENAI_API_KEY"',
          "",
        ].join("\n"),
      );
    },
    wirePath: /^\/v1\/responses/,
    writeFile: (path, content, workdir) => ({ name: "exec_command", arguments: JSON.stringify({ cmd: `printf '%s' '${content}' > '${path}'`, workdir }) }),
  },
];

/** A fixture entry, in aimock's JSON fixture format. */
export type AimockFixture = { match: Record<string, unknown>; response: Record<string, unknown> };

/** A running aimock; add a test's fixtures with `script` once their paths are known. */
export async function startAimock(): Promise<{ mock: LLMock; url: string }> {
  const mock = new LLMock({ port: 0 });
  const url = await mock.start();
  return { mock, url };
}

/** Load a test's fixtures, then a catch-all: anything a CLI asks on its own (a title, a summary) gets a short answer, never a miss. */
export function script(mock: LLMock, fixtures: AimockFixture[]): void {
  mock.addFixturesFromJSON([...fixtures, { match: {}, response: { content: "ok" } }] as never);
}

/** The newest request body (as JSON text) that carries `text`. */
export function requestWith(mock: LLMock, text: string): string | undefined {
  return mock
    .getRequests()
    .map((r) => JSON.stringify(r.body ?? ""))
    .filter((b) => b.includes(text))
    .at(-1);
}
