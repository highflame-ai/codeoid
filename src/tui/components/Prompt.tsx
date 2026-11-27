/**
 * Prompt — thin wrapper that renders either an empty-state disabled row or
 * the multiline PromptEditor. The hint row above the editor shows either
 * slash-command completions or the keybinding hint strip.
 */

import React from "react";
import { Box, Text } from "ink";
import { PromptEditor } from "./PromptEditor.js";
import { SlashHint, filterCommands } from "./SlashHint.js";
import { FileHint } from "./FileHint.js";

interface Props {
  value: string;
  cursor: number;
  onChange: (v: string) => void;
  onCursorChange: (pos: number) => void;
  onSubmit: () => void;
  onHistoryCycle: (direction: "prev" | "next") => void;
  hint?: string;
  disabled?: boolean;
  /**
   * False while a dialog owns the keyboard: the prompt stays on screen but
   * takes no keys, or ↑/Enter in a picker would also recall and re-send history.
   */
  inputActive?: boolean;
  /** Selected index within the slash-command hint list. */
  slashSelectedIdx?: number;
  /** When set, render the @file mention overlay above the prompt. */
  fileHint?: {
    query: string;
    matches: string[];
    selectedIdx: number;
  } | null;
}

export function Prompt({
  value,
  cursor,
  onChange,
  onCursorChange,
  onSubmit,
  onHistoryCycle,
  hint,
  disabled,
  inputActive = true,
  slashSelectedIdx = 0,
  fileHint,
}: Props) {
  const isSlashQuery =
    !disabled &&
    !fileHint &&
    value.startsWith("/") &&
    !value.includes("\n") &&
    filterCommands(value).length > 0;

  return (
    <Box flexDirection="column">
      {fileHint && (
        <FileHint
          query={fileHint.query}
          matches={fileHint.matches}
          selectedIdx={fileHint.selectedIdx}
        />
      )}
      {isSlashQuery && <SlashHint input={value} selectedIdx={slashSelectedIdx} />}
      <Box paddingX={1} flexDirection="column">
        {hint && !isSlashQuery && (
          // wrap="truncate-end" keeps the hint at exactly 1 row even on
          // narrow terminals. Without it, soft-wrap adds rows Ink's
          // layout engine doesn't count, which desyncs cursor math in
          // the live region and stacks the status bar above on each
          // re-render. Same root cause as the fix in StatusBar.
          <Text dimColor wrap="truncate-end">
            {hint}
          </Text>
        )}
        {disabled ? (
          <Box>
            <Text color="cyan" bold>
              {"› "}
            </Text>
            <Text dimColor>(no session focused)</Text>
          </Box>
        ) : (
          <PromptEditor
            value={value}
            onChange={onChange}
            onSubmit={onSubmit}
            cursor={cursor}
            onCursorChange={onCursorChange}
            history={[]}
            onHistoryCycle={onHistoryCycle}
            disabled={!inputActive}
          />
        )}
      </Box>
    </Box>
  );
}
