/**
 * TUI Output — scrollable output window showing agent responses.
 * Renders lines of output including text, tool calls, tool results, and errors.
 */

import React from "react";
import { Box, Text } from "ink";

export type OutputLineType =
  | "text"
  | "tool_call"
  | "tool_result_ok"
  | "tool_result_err"
  | "phase"
  | "error"
  | "done"
  | "info"
  | "divider";

export interface OutputLine {
  id: number;
  type: OutputLineType;
  content: string;
  /** Raw chalk-colored string for rendering */
  raw?: string;
}

interface OutputProps {
  lines: OutputLine[];
  /** Maximum number of visible lines before scrolling */
  maxLines?: number;
}

/**
 * Render a line with appropriate color based on its type.
 * Ink supports chalk strings inside <Text>, so we can pass raw chalked strings.
 */
const LineRenderer: React.FC<{ line: OutputLine }> = ({ line }) => {
  // If we have a pre-formatted chalk string, use it directly
  if (line.raw) {
    return <Text>{line.raw}</Text>;
  }

  switch (line.type) {
    case "text":
      return <Text>{line.content}</Text>;
    case "tool_call":
      return <Text color="cyan">◇ {line.content}</Text>;
    case "tool_result_ok":
      return <Text dimColor>┆ ✓ {line.content}</Text>;
    case "tool_result_err":
      return <Text color="red">┆ ✗ {line.content}</Text>;
    case "phase":
      return <Text dimColor>{line.content}</Text>;
    case "error":
      return <Text color="red">✗ {line.content}</Text>;
    case "done":
      return <Text color="green">✓ {line.content}</Text>;
    case "info":
      return <Text dimColor>{line.content}</Text>;
    case "divider":
      return <Text dimColor>{line.content}</Text>;
    default:
      return <Text>{line.content}</Text>;
  }
};

export const Output: React.FC<OutputProps> = ({ lines, maxLines = 100 }) => {
  // Show only the last maxLines
  const visible = lines.length > maxLines ? lines.slice(lines.length - maxLines) : lines;

  return (
    <Box flexDirection="column" flexGrow={1} overflowY="hidden">
      {visible.length === 0 ? (
        <Box paddingY={1}>
          <Text dimColor>Type a prompt to start, or /help for commands.</Text>
        </Box>
      ) : (
        visible.map((line) => (
          <LineRenderer key={line.id} line={line} />
        ))
      )}
    </Box>
  );
};
