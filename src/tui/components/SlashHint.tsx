/**
 * SlashHint — inline command suggestion panel.
 *
 * Renders above the prompt when the buffer starts with `/` and has no newlines.
 * Tab completion is applied by the parent (App.tsx) — this component is pure
 * presentation.
 */

import React from "react";
import { Box, Text } from "ink";

export interface SlashCommand {
  name: string;
  description: string;
}

export const SLASH_COMMANDS: SlashCommand[] = [
  { name: "/clear", description: "Clear the visible transcript (keeps memory)" },
  { name: "/new", description: "Create a new session (alias for Ctrl-N)" },
  { name: "/switch", description: "Switch to another session (alias for Ctrl-G)" },
  { name: "/destroy", description: "Destroy the focused session" },
  { name: "/interrupt", description: "Interrupt the focused session" },
  { name: "/mode", description: "Cycle session mode (interactive/guarded/autonomous)" },
  { name: "/pin", description: "Pin a file to the session (prepended every turn)" },
  { name: "/unpin", description: "Unpin a previously-pinned file" },
  { name: "/context", description: "Show detailed context-budget breakdown — or attach files if paths given" },
  { name: "/rotate", description: "Rotate the Claude Code backing session (fresh context, memory preserved)" },
  { name: "/search", description: "Search sessions (Ctrl-F) — keywords + semantic + recency; Tab toggles this workspace ↔ all" },
  { name: "/model", description: "Switch the Claude model for this session (interactive picker, or /model <alias>)" },
  { name: "/who", description: "Show the identity chain (user → agent → sub-agents)" },
  { name: "/help", description: "Show keybindings" },
];

/** Return the subset of commands matching the current input (prefix match). */
export function filterCommands(input: string): SlashCommand[] {
  if (!input.startsWith("/")) return [];
  const prefix = input.split(/\s/)[0]!.toLowerCase();
  return SLASH_COMMANDS.filter((c) => c.name.startsWith(prefix));
}

interface Props {
  input: string;
  selectedIdx: number;
}

export function SlashHint({ input, selectedIdx }: Props) {
  const matches = filterCommands(input);
  if (matches.length === 0) return null;

  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor="cyan"
      paddingX={1}
      marginBottom={0}
    >
      {matches.map((cmd, i) => (
        <Box key={cmd.name}>
          <Text color={i === selectedIdx ? "cyan" : "white"} bold={i === selectedIdx}>
            {i === selectedIdx ? "▸ " : "  "}
            {cmd.name}
          </Text>
          <Text dimColor>  — {cmd.description}</Text>
        </Box>
      ))}
      <Box marginTop={0}>
        <Text dimColor>Tab to complete · Enter to run · Esc to cancel</Text>
      </Box>
    </Box>
  );
}
