/**
 * TUI Input — text input box for user prompts.
 * Uses ink-text-input for the input field.
 */

import React, { useState, useCallback } from "react";
import { Box, Text } from "ink";
import TextInput from "ink-text-input";

interface InputProps {
  onSubmit: (value: string) => void;
  disabled?: boolean;
  prompt?: string;
}

export const Input: React.FC<InputProps> = ({
  onSubmit,
  disabled = false,
  prompt = "❯ ",
}) => {
  const [value, setValue] = useState("");

  const handleSubmit = useCallback(
    (val: string) => {
      const trimmed = val.trim();
      if (!trimmed) return;
      setValue("");
      onSubmit(trimmed);
    },
    [onSubmit],
  );

  return (
    <Box flexDirection="column" borderStyle="single" borderColor="gray" paddingX={1}>
      {disabled ? (
        <Text dimColor>Agent is running... (Ctrl+C to interrupt)</Text>
      ) : (
        <Box>
          <Text color="cyan">{prompt}</Text>
          <TextInput
            value={value}
            onChange={setValue}
            onSubmit={handleSubmit}
            showCursor={!disabled}
            placeholder="Type a prompt or /command..."
          />
        </Box>
      )}
    </Box>
  );
};
