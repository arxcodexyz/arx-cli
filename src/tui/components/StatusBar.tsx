/**
 * TUI StatusBar — shows current phase, token count, elapsed time.
 */

import React from "react";
import { Box, Text } from "ink";

// ── Phase Emoji ───────────────────────────────────────────────────

function phaseIcon(phase: string): string {
  switch (phase) {
    case "plan": return "🧠";
    case "act": return "🔧";
    case "observe": return "👀";
    case "verify": return "✅";
    case "settle": return "🏁";
    case "idle": return "💤";
    default: return "•";
  }
}

function phaseLabel(phase: string): string {
  switch (phase) {
    case "plan": return "Planning...";
    case "act": return "Acting...";
    case "observe": return "Observing...";
    case "verify": return "Verifying...";
    case "settle": return "Done.";
    case "idle": return "Idle";
    default: return phase;
  }
}

interface StatusBarProps {
  phase: string;
  steps?: number;
  inputTokens?: number;
  outputTokens?: number;
  elapsedMs?: number;
}

function formatTime(ms: number): string {
  const seconds = ms / 1000;
  if (seconds < 60) return `${seconds.toFixed(1)}s`;
  const mins = Math.floor(seconds / 60);
  const secs = (seconds % 60).toFixed(0);
  return `${mins}m ${secs}s`;
}

function formatTokens(n: number): string {
  if (n >= 1000) return `${(n / 1000).toFixed(1)}K`;
  return n.toString();
}

export const StatusBar: React.FC<StatusBarProps> = ({
  phase,
  steps,
  inputTokens = 0,
  outputTokens = 0,
  elapsedMs = 0,
}) => {
  const icon = phaseIcon(phase);
  const label = phaseLabel(phase);
  const hasTokens = inputTokens > 0 || outputTokens > 0;
  const stepsStr = steps != null ? `${steps} step${steps !== 1 ? "s" : ""}` : "";

  return (
    <Box borderStyle="single" borderColor="gray" paddingX={1} justifyContent="space-between">
      <Box>
        <Text>{icon} </Text>
        <Text
          color={phase === "idle" ? "gray" : phase === "settle" ? "green" : "cyan"}
        >
          {label}
        </Text>
      </Box>
      <Box>
        {stepsStr && (
          <Text dimColor> {stepsStr} </Text>
        )}
        {hasTokens && (
          <Text dimColor>
            ↥{formatTokens(inputTokens)} ↧{formatTokens(outputTokens)}{" "}
          </Text>
        )}
        {elapsedMs > 0 && (
          <Text dimColor> {formatTime(elapsedMs)} </Text>
        )}
      </Box>
    </Box>
  );
};
