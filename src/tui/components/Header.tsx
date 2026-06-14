/**
 * TUI Header — shows ArxCode banner, provider, model, project info.
 */

import React from "react";
import { Box, Text } from "ink";
import { showBanner } from "../../banner.js";
import type { SessionState } from "../../commands.js";

interface HeaderProps {
  state: SessionState;
  version: string;
}

export const Header: React.FC<HeaderProps> = ({ state, version }) => {
  const banner = showBanner(version);
  const provider = state.providerId;
  const model = state.model || "(default)";
  const project = state.projectRoot;
  const contextNames = state.contextFiles?.map(f => f.name).join(", ") || "";

  return (
    <Box flexDirection="column" borderStyle="round" borderColor="cyan" paddingX={1}>
      {/* Banner rendered as raw chalk strings — Ink supports chalk in <Text> */}
      {banner.split("\n").map((line, i) => (
        <Text key={i}>{line}</Text>
      ))}
      <Box marginTop={0}>
        <Text dimColor>
          {provider}  ·  {model}  ·  {project}
        </Text>
      </Box>
      {contextNames && (
        <Text dimColor>context: {contextNames}</Text>
      )}
      {!state.apiKey && (
        <Text color="yellow">⚠ no API key — use /key or /provider to configure</Text>
      )}
    </Box>
  );
};
