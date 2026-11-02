/**
 * The shell command in a tool call, whatever the backend calls its shell tool
 * and however it shapes the input (#431).
 */
import { decodeCompressedCommand } from "../compress/prehook.js";

/**
 * Shell tools under every backend's name (normalized or raw: Bash, bash,
 * run_shell_command, shell, exec_command…), and every other tool that runs
 * a shell command: Claude's Monitor (`command`, a shell command or script
 * whose output lines are events), and its PowerShell (Windows), whose
 * language #431's reader doesn't read: its command is never understood, so
 * it always asks.
 */
const SHELL_TOOL_NAMES = new Set(["run_shell", "bash", "shell", "run_shell_command", "exec_command", "local_shell", "terminal", "exec", "monitor", "powershell"]);
/** Shell tools whose command isn't a POSIX shell line. */
const NOT_BASH = new Set(["powershell"]);

export function isShellTool(name: string, original: string = name): boolean {
  return SHELL_TOOL_NAMES.has(name.toLowerCase()) || SHELL_TOOL_NAMES.has(original.toLowerCase());
}

/** A shell tool's call that runs no command by design: Claude's Monitor watching a WebSocket (`ws`) instead. */
export function runsNoCommand(name: string, input: Record<string, unknown>): boolean {
  return name.toLowerCase() === "monitor" && input.command === undefined && input.ws !== undefined;
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
  if (!isShellTool(toolName) || NOT_BASH.has(toolName.toLowerCase())) return null;
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
