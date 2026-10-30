/**
 * The shell command in a tool call, whatever the backend calls its shell tool
 * and however it shapes the input (#431).
 */
import { decodeCompressedCommand } from "../compress/prehook.js";

/** Shell tools under every backend's name (normalized or raw: Bash, bash, run_shell_command, shell, exec_command…). */
const SHELL_TOOL_NAMES = new Set(["run_shell", "bash", "shell", "run_shell_command", "exec_command", "local_shell", "terminal", "exec"]);

export function isShellTool(name: string, original: string = name): boolean {
  return SHELL_TOOL_NAMES.has(name.toLowerCase()) || SHELL_TOOL_NAMES.has(original.toLowerCase());
}

/** The command a shell tool ran, for display: an argv is joined with spaces. */
export function shellCommandOf(input: Record<string, unknown>): string {
  for (const k of ["command", "cmd", "script"]) {
    const v = input[k];
    if (typeof v === "string") return v;
    if (Array.isArray(v)) return v.map(String).join(" ");
  }
  return "";
}

/** Input keys a backend's shell tool uses for the directory it runs in. */
const CWD_KEYS = ["cwd", "directory", "dir_path", "workdir", "working_directory"] as const;

/**
 * The command line a shell tool call runs, exactly — an argv is quoted back
 * into one line, and codeoid's own output-compression wrapper is seen
 * through (to the command it runs, in its `--cwd`) — with the directory it
 * names, if any. Null when the call isn't a shell command, or its command
 * can't be read.
 */
export function shellCallOf(toolName: string, input: Record<string, unknown>): { command: string; cwd: string | null } | null {
  if (!isShellTool(toolName)) return null;
  let command: string | null = null;
  for (const k of ["command", "cmd", "script"]) {
    const v = input[k];
    if (typeof v === "string") command = v;
    else if (Array.isArray(v) && v.every((x) => typeof x === "string")) command = (v as string[]).map(quote).join(" ");
    if (command !== null) break;
  }
  if (command === null) return null;
  const compressed = decodeCompressedCommand(command);
  if (compressed) return { command: compressed.command, cwd: compressed.cwd };
  let cwd: string | null = null;
  for (const k of CWD_KEYS) {
    const v = input[k];
    if (typeof v === "string" && v.length > 0) {
      cwd = v;
      break;
    }
  }
  return { command, cwd };
}

/** One argv element as a shell word. */
function quote(s: string): string {
  if (/^[A-Za-z0-9_./@:+=,%-]+$/.test(s)) return s;
  return `'${s.replace(/'/g, `'\\''`)}'`;
}
