/**
 * A stand-in stdio MCP server for claude-sandbox-probe.ts: writes the names
 * and values of the environment it was started with to the file it is given,
 * then exits (the CLI marks the server failed; the probe only reads the file).
 */
import { writeFileSync } from "node:fs";

writeFileSync(process.argv[2] ?? "/dev/null", JSON.stringify(process.env));
