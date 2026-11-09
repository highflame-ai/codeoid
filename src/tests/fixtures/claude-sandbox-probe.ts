/**
 * Runs the REAL Claude Code CLI (the Agent SDK's bundled binary) with
 * codeoid's sandbox option (#448) against a localhost stand-in for the
 * Messages API — no model, no vendor: the stand-in answers the first request
 * with one Bash call and the next with "finished". Prints one JSON line:
 * what the call's result said and which tool calls reached canUseTool.
 *
 *   bun claude-sandbox-probe.ts <root> <on|off|allowlist> <command-file> [unsandboxed|policy|policy-env|policy-env-unsandboxed] [allowHost]
 *
 * `<root>` holds the planted files (`ws`, `tmp`, `secrets`); the command is
 * read from a file so it is never part of a shell line. `policy`: the spec
 * is codeoid's own (buildSandboxSpec) for a fake home `<root>/home` with the
 * workspace `<root>/home/proj` (or `<root>/wt` when it exists: a worktree),
 * and the CLI gets the session's temp dirs as the provider gives them
 * (claudeTempEnv), under `<root>/sbx`. `policy-env`: the same, with the
 * CLI's environment as the provider builds it (claudeNativeEnv: the cache
 * variables for sandboxed commands only), a stdio MCP server that writes
 * the environment it got to `<root>/mcp-env.json`, and the caller's own
 * environment carrying a stale `SANDBOX_RUNTIME`; `policy-env-unsandboxed`:
 * that, with the call asking to run outside the sandbox and allowed (the
 * owner's yes). `policy-env-git` / `policy-env-nogit`: `policy-env` with the
 * CLI's own git the session's shim (git-shim.ts: git inside the sandbox,
 * offline, with an environment of its own) or not, and a second query after the first (a new
 * CLI start in the same workspace, the one that runs its `git status`);
 * the second one's system prompt is told as `system`. A workspace of the
 * test's own: `CODEOID_PROBE_WORKSPACE`; the session's cwd below it
 * (a monorepo's package; the CLI then loads the project's settings):
 * `CODEOID_PROBE_WORKDIR`; the session's worktree folder
 * name: `CODEOID_PROBE_WORKTREE_FOLDER`; its project roots and added dirs
 * (comma-separated): `CODEOID_PROBE_PROJECT_ROOTS`, `CODEOID_PROBE_ADDED_DIRS`. Run in its own
 * process: a test file that mocks the SDK module must not see this one.
 * canUseTool here allows a sandboxed call and DENIES one asking to run
 * outside the sandbox, as codeoid's gate would until its owner says yes.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { query } from "@anthropic-ai/claude-agent-sdk";
import { type ClaudeTempDirs, claudeNativeEnv, claudeSandboxSettings, claudeTempEnv } from "../../daemon/sandbox/claude-native.js";
import { BwrapSandboxProvider } from "../../daemon/sandbox/bwrap.js";
import { CWD_FROM_CALLER } from "../../daemon/sandbox/docker.js";
import { cliWorktrees, gitProgramLocations, gitShimSpec, writeGitShim } from "../../daemon/sandbox/git-shim.js";
import { unguardedArgv } from "../../daemon/sandbox/pinned.js";
import { buildSandboxSpec } from "../../daemon/sandbox/policy.js";
import { daemonTempDir } from "../../daemon/sandbox/root.js";
import { launcherScript } from "../../daemon/sandbox/session-sandbox.js";
import { GIT_BIN } from "../../daemon/git-env.js";

const [root = "", networkArg = "off", commandFile = "", flag = "", allowHost = ""] = process.argv.slice(2);
const network = networkArg as "on" | "off" | "allowlist";
const command = readFileSync(commandFile, "utf8");
const gitMode = flag === "policy-env-git" ? "shim" : flag === "policy-env-nogit" ? "none" : null;
const nativeEnv = flag === "policy-env" || flag === "policy-env-unsandboxed" || gitMode !== null;
const unsandboxed = flag === "unsandboxed" || flag === "policy-env-unsandboxed";
const allowUnsandboxed = flag === "policy-env-unsandboxed";
const policy = flag === "policy" || nativeEnv;

let toolResult: string | null = null;
let system = "";
const sse = (events: Array<[string, unknown]>) => events.map(([e, d]) => `event: ${e}\ndata: ${JSON.stringify(d)}\n\n`).join("");
function stream(content: Array<Record<string, unknown>>, stop: string): string {
  const events: Array<[string, unknown]> = [
    ["message_start", { type: "message_start", message: { id: "msg", type: "message", role: "assistant", model: "claude-test", content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } } }],
  ];
  content.forEach((block, i) => {
    if (block.type === "text") {
      events.push(["content_block_start", { type: "content_block_start", index: i, content_block: { type: "text", text: "" } }]);
      events.push(["content_block_delta", { type: "content_block_delta", index: i, delta: { type: "text_delta", text: block.text } }]);
    } else {
      events.push(["content_block_start", { type: "content_block_start", index: i, content_block: { type: "tool_use", id: block.id, name: block.name, input: {} } }]);
      events.push(["content_block_delta", { type: "content_block_delta", index: i, delta: { type: "input_json_delta", partial_json: JSON.stringify(block.input) } }]);
    }
    events.push(["content_block_stop", { type: "content_block_stop", index: i }]);
  });
  events.push(["message_delta", { type: "message_delta", delta: { stop_reason: stop, stop_sequence: null }, usage: { output_tokens: 1 } }]);
  events.push(["message_stop", { type: "message_stop" }]);
  return sse(events);
}

const server = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  async fetch(req) {
    if (!new URL(req.url).pathname.endsWith("/messages")) return Response.json({ data: [] });
    const body = (await req.json()) as { system?: unknown; tools?: Array<{ name: string }>; messages: Array<{ role: string; content: unknown }> };
    system += JSON.stringify(body.system ?? "") + JSON.stringify(body.messages);
    for (const m of body.messages) {
      if (!Array.isArray(m.content)) continue;
      for (const c of m.content as Array<{ type?: string; tool_use_id?: string; content?: unknown }>) {
        if (c.type === "tool_result" && c.tool_use_id === "toolu_probe") toolResult = typeof c.content === "string" ? c.content : JSON.stringify(c.content);
      }
    }
    let content: Array<Record<string, unknown>> = [{ type: "text", text: "ok" }];
    let stop = "end_turn";
    if (toolResult !== null) content = [{ type: "text", text: "finished" }];
    else if (body.tools?.some((t) => t.name === "Bash")) {
      content = [{ type: "tool_use", id: "toolu_probe", name: "Bash", input: { command, description: "probe", ...(unsandboxed ? { dangerouslyDisableSandbox: true } : {}) } }];
      stop = "tool_use";
    }
    return new Response(stream(content, stop), { headers: { "content-type": "text/event-stream" } });
  },
});

const home = policy ? join(root, "home") : join(root, "home");
const workspace = process.env.CODEOID_PROBE_WORKSPACE || (policy ? (existsSync(join(root, "wt")) ? join(root, "wt") : join(home, "proj")) : join(root, "ws"));
const uid = typeof process.getuid === "function" ? process.getuid() : 0;
const temp: ClaudeTempDirs = { cli: join(root, "sbx", "cli"), root: join(root, "sbx", "cmd"), commands: join(root, "sbx", "cmd", `claude-${uid}`) };
if (policy) for (const d of [temp.cli, temp.commands, workspace]) mkdirSync(d, { recursive: true });
const env: Record<string, string> = {
  PATH: process.env.PATH ?? "/usr/bin:/bin",
  HOME: home,
  ANTHROPIC_API_KEY: "sk-test-not-a-real-key",
  ANTHROPIC_BASE_URL: `http://127.0.0.1:${server.port}`,
  CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
  DISABLE_AUTOUPDATER: "1",
  ...(policy ? { ...claudeTempEnv(temp), GIT_CONFIG_NOSYSTEM: "1" } : {}),
};
const config = { provider: "auto", network, allowedHosts: [], hiddenPaths: [], homeReadable: ["~/.gitconfig", "~/.bun"], docker: { image: "x" }, ...(process.env.CODEOID_PROBE_BWRAP_PATH ? { bwrapPath: process.env.CODEOID_PROBE_BWRAP_PATH } : {}) };
const spec = policy
  ? buildSandboxSpec({
      sessionId: "probe",
      workspace,
      // CODEOID_PROBE_WORKDIR: the session's cwd below the workspace (a monorepo's package), which the CLI starts in
      // with the project's settings (a new Claude start there loads them).
      ...(process.env.CODEOID_PROBE_WORKDIR ? { workdir: process.env.CODEOID_PROBE_WORKDIR } : {}),
      tempDir: join(root, "tmp"),
      network: network === "allowlist" ? { mode: network, allow: [allowHost] } : { mode: network },
      config: { sandbox: config } as never,
      // CODEOID_PROBE_RUNTIME_DIR: the desktop runtime dir (hidden), where a planted socket stands in for rootless
      // Docker's; CODEOID_PROBE_DOCKER_SOCKET=1: the owner let commands reach it (spec.dockerSockets).
      hidden: { home, configDir: join(home, ".codeoid"), env: { HOME: home, ...(process.env.CODEOID_PROBE_RUNTIME_DIR ? { XDG_RUNTIME_DIR: process.env.CODEOID_PROBE_RUNTIME_DIR } : {}) }, daemonTmp: "/tmp" },
      dockerSocket: process.env.CODEOID_PROBE_DOCKER_SOCKET === "1",
      // CODEOID_PROBE_WORKTREE_FOLDER: the session's worktree folder name (sandbox/worktrees.ts).
      ...(process.env.CODEOID_PROBE_WORKTREE_FOLDER ? { worktreeFolder: process.env.CODEOID_PROBE_WORKTREE_FOLDER } : {}),
      // CODEOID_PROBE_PROJECT_ROOTS / CODEOID_PROBE_ADDED_DIRS (comma-separated): working across repositories.
      ...(process.env.CODEOID_PROBE_PROJECT_ROOTS ? { projectRoots: process.env.CODEOID_PROBE_PROJECT_ROOTS.split(",") } : {}),
      ...(process.env.CODEOID_PROBE_ADDED_DIRS ? { addedDirs: process.env.CODEOID_PROBE_ADDED_DIRS.split(",").map((dir) => ({ dir })) } : {}),
    })
  : {
      sessionId: "probe",
      workspace: join(root, "ws"),
      tempDir: join(root, "tmp"),
      writable: [],
      hidden: [join(root, "secrets")],
      reexposed: [],
      containerSockets: [],
      network: network === "allowlist" ? { mode: network, allow: [allowHost] } : { mode: network },
      unsetEnv: [],
    };
const sandbox = claudeSandboxSettings({ spec, config } as never, env, policy ? temp : undefined);
/** The session's git shim, as SessionSandbox makes it: a launcher for its spec (the command sandbox, offline, a fresh temp dir per git), in a daemon-private dir. */
function gitShim(): string {
  const handle = new BwrapSandboxProvider().openSync(gitShimSpec(buildSandboxSpec({
    sessionId: "probe",
    workspace,
    tempDir: join(root, "tmp"),
    network: { mode: "off" },
    config: { sandbox: config } as never,
    hidden: { home, configDir: join(home, ".codeoid"), env: { HOME: home }, daemonTmp: "/tmp" },
    backendReadable: gitProgramLocations(),
  }), { tempParent: daemonTempDir("git-tmp-probe-"), worktrees: cliWorktrees(workspace, home) }));
  const dir = daemonTempDir("launch-probe-");
  const wrapped = handle.wrap?.([GIT_BIN], { cwd: CWD_FROM_CALLER, env: {} });
  if (!wrapped) throw new Error("no wrap");
  const launcher = join(dir, "launch-git");
  writeFileSync(launcher, launcherScript(wrapped.argv), { mode: 0o700 });
  return writeGitShim(join(dir, "git-bin"), { launcher, provider: unguardedArgv(wrapped.argv)[0] ?? null, caller: "the Claude CLI", home });
}
const cliEnv = nativeEnv ? claudeNativeEnv(spec as never, temp, { ...env, SANDBOX_RUNTIME: "1" }, gitMode === "shim" ? gitShim() : undefined) : env;
// A sign-in started after the session's sandbox was built (#448 round 2): its home where the daemon makes it, the
// path told to the test through a file.
if (process.env.CODEOID_PROBE_SIGNIN_PATH) {
  const signin = daemonTempDir("codeoid-login-");
  writeFileSync(join(signin, ".credentials.json"), "PLANTED-SIGNIN-TOKEN\n");
  writeFileSync(process.env.CODEOID_PROBE_SIGNIN_PATH, signin);
}
const asked: string[] = [];
let result = "";
async function run(): Promise<void> {
  for await (const m of query({
    prompt: "run the probe",
    options: {
      cwd: process.env.CODEOID_PROBE_WORKDIR || workspace,
      env: cliEnv,
      sandbox,
      ...(nativeEnv ? { mcpServers: { probe: { type: "stdio" as const, command: process.execPath, args: [join(import.meta.dir, "env-dump.ts"), join(root, "mcp-env.json")] } } } : {}),
      permissionMode: "default",
      settingSources: process.env.CODEOID_PROBE_WORKDIR ? ["project", "user"] : [],
      // The preset's context carries the CLI's git status (what its own git found).
      ...(gitMode ? { systemPrompt: { type: "preset" as const, preset: "claude_code" as const } } : {}),
      canUseTool: async (name, input) => {
        asked.push(name);
        if ((input as { dangerouslyDisableSandbox?: boolean }).dangerouslyDisableSandbox && !allowUnsandboxed) return { behavior: "deny", message: "denied by the gate" };
        return { behavior: "allow", updatedInput: input };
      },
    },
  })) {
    if (m.type === "result") result = m.subtype;
  }
}
let second: string | undefined;
try {
  await run();
  if (gitMode) {
    // A new CLI start in the same workspace: no tool call (the stand-in has its result), only the CLI's own git.
    const first = result;
    system = "";
    await run();
    second = result;
    result = first;
  }
} catch (err) {
  result = `failed: ${err instanceof Error ? err.message : String(err)}`;
}
server.stop(true);
console.log(JSON.stringify({ result, asked, toolResult, ...(gitMode ? { second, system } : {}) }));
