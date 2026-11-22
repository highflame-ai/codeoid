/**
 * Before the real-sandbox tests (CI's sandbox-real job): fail unless they can
 * run here. Each of them skips itself where bubblewrap, socat or the Agent
 * SDK's Claude Code CLI is missing, so without this a broken runner would
 * pass them all by skipping them.
 *
 *   bun scripts/check-real-sandbox.ts
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import { BwrapSandboxProvider } from "../src/daemon/sandbox/bwrap.ts";

const problems: string[] = [];
const bwrap = await new BwrapSandboxProvider().probe();
if (!bwrap.available) problems.push(`bubblewrap: ${bwrap.reason}`);
if (!Bun.which("socat")) problems.push("socat is not installed (Claude Code's Linux sandbox needs it)");
const cli = join(import.meta.dir, "..", "node_modules", "@anthropic-ai", `claude-agent-sdk-${process.platform}-${process.arch}`, "claude");
if (!existsSync(cli)) problems.push(`the Agent SDK's Claude Code CLI isn't installed (${cli})`);
if (!Bun.which("git")) problems.push("git is not installed");

if (problems.length > 0) {
  for (const p of problems) console.error(`✗ ${p}`);
  console.error("The real-sandbox tests would skip themselves here instead of running.");
  process.exit(1);
}
console.log(`✓ bubblewrap (${bwrap.available ? bwrap.detail : ""}), socat, git and the Claude Code CLI are here: the real-sandbox tests run.`);
