#!/usr/bin/env bun
/**
 * Codeoid compressor wrapper — spawn a shell command, compress stdout via
 * the registry, print to stdout with stderr preserved verbatim, exit with
 * the child's code.
 *
 * Invoked by the daemon's PreToolUse hook, which rewrites
 *   Bash({ command: "<X>" })
 * into
 *   Bash({ command: "bun <this file> --b64 <base64(X)>" })
 *
 * Base64 transport avoids every shell-escaping pothole — we don't have to
 * reason about $'...', nested quotes, or interpolation. The wrapper decodes,
 * runs via /bin/sh -c, compresses, prints.
 *
 * Exit code = child's exit code. stderr = child's stderr (verbatim, never
 * compressed; error fidelity matters). stdout = compressed text with a
 * trailing hint line when a rule fired.
 *
 * Diagnostics: stderr lines starting with `[codeoid-wrapper]` are wrapper-
 * level problems (bad args, spawn failed). Everything else is the child's.
 */

import { loadConfig } from "../../config.js";
import { createRegistry, runCompressed } from "./index.js";
import { defaultSpillDir } from "./spill.js";

function die(message: string, exitCode = 2): never {
  process.stderr.write(`[codeoid-wrapper] ${message}\n`);
  process.exit(exitCode);
}

function parseArgv(argv: readonly string[]): { command: string; workdir: string } {
  let command: string | null = null;
  let workdir: string = process.cwd();
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--b64") {
      const next = argv[i + 1];
      if (!next) die("--b64 requires an argument");
      try {
        command = Buffer.from(next!, "base64").toString("utf8");
      } catch (err) {
        die(
          `failed to decode --b64 payload: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
      i++;
    } else if (a === "--cwd") {
      const next = argv[i + 1];
      if (!next) die("--cwd requires an argument");
      workdir = next!;
      i++;
    } else if (a === "--cmd") {
      // Plain-text fallback — caller MUST quote safely. Kept for humans.
      const next = argv[i + 1];
      if (!next) die("--cmd requires an argument");
      command = next!;
      i++;
    } else {
      die(`unknown argument: ${a}`);
    }
  }
  if (command === null) die("missing --b64 or --cmd");
  return { command: command!, workdir };
}

async function main(): Promise<void> {
  const { command, workdir } = parseArgv(process.argv.slice(2));

  let config: ReturnType<typeof loadConfig>;
  try {
    config = loadConfig();
  } catch (err) {
    die(`config load failed: ${err instanceof Error ? err.message : String(err)}`);
    return;
  }

  // Run WITHOUT compression if the config flag is off. Wrapper becomes a
  // thin passthrough — zero behavior change. Makes the integration safe to
  // leave wired up permanently and toggle via config only.
  if (!config.compress.enabled) {
    await runRaw(command, workdir);
    return;
  }

  const registry = createRegistry(config);
  try {
    const outcome = await runCompressed({
      command,
      workdir,
      env: process.env as Record<string, string>,
      registry,
      minBytes: config.compress.minBytes,
      compressPipes: config.compress.compressPipes,
      // Memory is where the raw output goes; with memory off there's no
      // reader for a spill file, so don't leave one behind.
      spillDir: config.memory?.enabled ? defaultSpillDir() : undefined,
    });

    if (outcome.stderr.length > 0) process.stderr.write(outcome.stderr);
    process.stdout.write(outcome.stdout);
    process.exit(outcome.exitCode);
  } catch (err) {
    die(
      `execution failed: ${err instanceof Error ? err.message : String(err)}`,
      127,
    );
  }
}

async function runRaw(command: string, workdir: string): Promise<void> {
  const child = Bun.spawn(["/bin/sh", "-c", command], {
    cwd: workdir,
    env: process.env as Record<string, string>,
    stdout: "inherit",
    stderr: "inherit",
    stdin: "ignore",
  });
  const code = await child.exited;
  process.exit(code);
}

await main();
