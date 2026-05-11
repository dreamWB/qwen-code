/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * @fileoverview BaseTextInput — shared text input component with rendering
 * and common readline keyboard handling.
 *
 * Provides:
 *  - Viewport line rendering from a TextBuffer with cursor display
 *  - Placeholder support when buffer is empty
 *  - Configurable border/prefix styling
 *  - Standard readline shortcuts (Ctrl+A/E/K/U/W, Escape, etc.)
 *  - An `onKeypress` interceptor so consumers can layer custom behavior
 *
 * Used by both InputPrompt (with syntax highlighting + complex key handling)
 * and AgentComposer (with minimal customization).
 */

import type React from 'react';
import { useCallback } from 'react';
import { Box, Text } from 'ink';
import chalk from 'chalk';
import type { TextBuffer } from './shared/text-buffer.js';
import { getSelectionRange } from './shared/text-buffer.js';
import type { Key } from '../hooks/useKeypress.js';
import { useKeypress } from '../hooks/useKeypress.js';
import { keyMatchers, Command } from '../keyMatchers.js';
import stringWidth from 'string-width';
import { cpSlice, cpLen } from '../utils/textUtils.js';
import { theme } from '../semantic-colors.js';

// ─── Types ──────────────────────────────────────────────────

export interface RenderLineOptions {
  /** The text content of this visual line. */
  lineText: string;
  /** Whether the cursor is on this visual line. */
  isOnCursorLine: boolean;
  /** The cursor column within this visual line (visual col, not logical). */
  cursorCol: number;
  /** Whether the cursor should be rendered. */
  showCursor: boolean;
  /** Index of this line within the rendered viewport (0-based). */
  visualLineIndex: number;
  /** Absolute visual line index (scrollVisualRow + visualLineIndex). */
  absoluteVisualIndex: number;
  /** The underlying text buffer. */
  buffer: TextBuffer;
  /** The first visible visual row (scroll offset). */
  scrollVisualRow: number;
}

export interface BaseTextInputProps {
  /** The text buffer driving this input. */
  buffer: TextBuffer;
  /** Called when the user submits (Enter). Buffer is cleared automatically. */
  onSubmit: (text: string) => void;
  /**
   * Optional key interceptor. Called before default readline handling.
   * Return `true` if the key was handled (skips default processing).
   */
  onKeypress?: (key: Key) => boolean;
  /** Whether to show the blinking block cursor. Defaults to true. */
  showCursor?: boolean;
  /** Placeholder text shown when the buffer is empty. */
  placeholder?: string;
  /** Custom prefix node (defaults to `> `). */
  prefix?: React.ReactNode;
  /** Border color for the input box. */
  borderColor?: string;
  /** Label rendered on the top border line (right-aligned). Plain string for width calculation. */
  topRightLabel?: string;
  /** Whether keyboard handling is active. Defaults to true. */
  isActive?: boolean;
  /**
   * Custom line renderer for advanced rendering (e.g. syntax highlighting).
   * When not provided, lines are rendered as plain text with cursor overlay.
   */
  renderLine?: (opts: RenderLineOptions) => React.ReactNode;
}

// ─── Default line renderer ──────────────────────────────────

/**
 * Renders a single visual line with an inverse-video block cursor and optional
 * selection highlight (blue background). Uses codepoint-aware string operations
 * for Unicode/emoji safety.
 */
export function defaultRenderLine({
  lineText,
  isOnCursorLine,
  cursorCol,
  showCursor,
  absoluteVisualIndex,
  buffer,
}: RenderLineOptions): React.ReactNode {
  const len = cpLen(lineText);

  // Compute selection columns for this visual line (code-point indices).
  let selStart = 0;
  let selEnd = 0;
  if (buffer.selectionAnchor !== null) {
    const sel = getSelectionRange({
      selectionAnchor: buffer.selectionAnchor,
      cursorRow: buffer.cursor[0],
      cursorCol: buffer.cursor[1],
    });
    if (sel) {
      const mapping = buffer.visualToLogicalMap[absoluteVisualIndex];
      if (mapping) {
        const [logRow, startColInLogical] = mapping;
        if (logRow >= sel.startRow && logRow <= sel.endRow) {
          let s = 0;
          let e = len;
          if (logRow === sel.startRow) {
            s = Math.max(0, sel.startCol - startColInLogical);
          }
          if (logRow === sel.endRow) {
            e = Math.min(len, sel.endCol - startColInLogical);
          }
          if (s < e) {
            selStart = s;
            selEnd = e;
          }
        }
      }
    }
  }

  const hasSelection = selEnd > selStart;
  const showCursorHere = isOnCursorLine && showCursor;

  if (!hasSelection && !showCursorHere) {
    return <Text>{lineText || ' '}</Text>;
  }

  if (!hasSelection) {
    // Cursor only (original behavior)
    if (cursorCol >= len) {
      return (
        <Text>
          {lineText}
          {chalk.inverse(' ') + '\u200B'}
        </Text>
      );
    }
    return (
      <Text>
        {cpSlice(lineText, 0, cursorCol)}
        {chalk.inverse(cpSlice(lineText, cursorCol, cursorCol + 1))}
        {cpSlice(lineText, cursorCol + 1)}
      </Text>
    );
  }

  // Selection active on this line. Build segments between boundary points.
  // Cursor (if shown) renders as chalk.inverse; selected chars as chalk.bgBlue.
  const C = showCursorHere && cursorCol < len ? cursorCol : -1;
  const S = selStart;
  const E = selEnd;

  const boundarySet = new Set([0, S, E, len]);
  if (C >= 0) {
    boundarySet.add(C);
    boundarySet.add(C + 1);
  }
  const boundaries = [...boundarySet].sort((a, b) => a - b);

  const styled = boundaries.slice(0, -1).map((start, i) => {
    const end = boundaries[i + 1];
    if (start >= end) return '';
    const chunk = cpSlice(lineText, start, end);
    const isCursorSpan = C >= 0 && start === C && end === C + 1;
    const inSelection = start >= S && end <= E;
    if (isCursorSpan) return chalk.inverse(chunk);
    if (inSelection) return chalk.bgBlue(chunk);
    return chunk;
  });

  const trailingCursor =
    showCursorHere && cursorCol >= len ? chalk.inverse(' ') + '\u200B' : '';

  return <Text>{styled.join('') + trailingCursor}</Text>;
}

// ─── Component ──────────────────────────────────────────────

export const BaseTextInput: React.FC<BaseTextInputProps> = ({
  buffer,
  onSubmit,
  onKeypress,
  showCursor = true,
  placeholder,
  prefix,
  borderColor,
  topRightLabel,
  isActive = true,
  renderLine = defaultRenderLine,
}) => {
  // ── Keyboard handling ──

  const handleKey = useCallback(
    (key: Key) => {
      // Let the consumer intercept first
      if (onKeypress?.(key)) {
        return;
      }

      if (keyMatchers[Command.TOGGLE_RENDER_MODE](key)) {
        return;
      }

      // ── Standard readline shortcuts ──

      // Submit (Enter, no modifiers)
      if (keyMatchers[Command.SUBMIT](key)) {
        if (buffer.text.trim()) {
          const text = buffer.text;
          buffer.setText('');
          onSubmit(text);
        }
        return;
      }

      // Newline (Shift+Enter, Ctrl+Enter, Ctrl+J)
      if (keyMatchers[Command.NEWLINE](key)) {
        buffer.newline();
        return;
      }

      // Escape → clear selection first; if none, clear input
      if (keyMatchers[Command.ESCAPE](key)) {
        if (buffer.selectionAnchor !== null) {
          buffer.clearSelection();
        } else if (buffer.text.length > 0) {
          buffer.setText('');
        }
        return;
      }

      // Ctrl+C → clear selection first; if none, clear input
      if (keyMatchers[Command.CLEAR_INPUT](key)) {
        if (buffer.selectionAnchor !== null) {
          buffer.clearSelection();
        } else if (buffer.text.length > 0) {
          buffer.setText('');
        }
        return;
      }

      // Ctrl+A → home
      if (keyMatchers[Command.HOME](key)) {
        buffer.move('home');
        return;
      }

      // Ctrl+E → end
      if (keyMatchers[Command.END](key)) {
        buffer.move('end');
        return;
      }

      // Ctrl+K → kill to end of line
      if (keyMatchers[Command.KILL_LINE_RIGHT](key)) {
        buffer.killLineRight();
        return;
      }

      // Ctrl+U → kill to start of line
      if (keyMatchers[Command.KILL_LINE_LEFT](key)) {
        buffer.killLineLeft();
        return;
      }

      // Ctrl+W / Alt+Backspace → delete word backward
      if (keyMatchers[Command.DELETE_WORD_BACKWARD](key)) {
        buffer.deleteWordLeft();
        return;
      }

      // Ctrl+X Ctrl+E → open in external editor
      if (keyMatchers[Command.OPEN_EXTERNAL_EDITOR](key)) {
        buffer.openInExternalEditor();
        return;
      }

      // ── Text selection ──

      if (keyMatchers[Command.SELECT_ALL](key)) {
        buffer.selectAll();
        return;
      }

      if (keyMatchers[Command.SELECT_LEFT](key)) {
        buffer.extendSelection('left');
        return;
      }

      if (keyMatchers[Command.SELECT_RIGHT](key)) {
        buffer.extendSelection('right');
        return;
      }

      if (keyMatchers[Command.SELECT_UP](key)) {
        buffer.extendSelection('up');
        return;
      }

      if (keyMatchers[Command.SELECT_DOWN](key)) {
        buffer.extendSelection('down');
        return;
      }

      if (keyMatchers[Command.SELECT_WORD_LEFT](key)) {
        buffer.extendSelection('wordLeft');
        return;
      }

      if (keyMatchers[Command.SELECT_WORD_RIGHT](key)) {
        buffer.extendSelection('wordRight');
        return;
      }

      if (keyMatchers[Command.SELECT_HOME](key)) {
        buffer.extendSelection('home');
        return;
      }

      if (keyMatchers[Command.SELECT_END](key)) {
        buffer.extendSelection('end');
        return;
      }

      // Tab — never insert literal tab characters into the buffer;
      // consumers that need Tab behaviour should intercept it via onKeypress.
      if ((key.name === 'tab' || key.sequence === '\t') && !key.paste) {
        return;
      }

      // Backspace
      if (
        key.name === 'backspace' ||
        key.sequence === '\x7f' ||
        (key.ctrl && key.name === 'h')
      ) {
        buffer.backspace();
        return;
      }

      // Fallthrough — delegate to buffer's built-in input handler
      buffer.handleInput(key);
    },
    [buffer, onSubmit, onKeypress],
  );

  useKeypress(handleKey, { isActive });

  // ── Rendering ──

  const linesToRender = buffer.viewportVisualLines;
  const [cursorVisualRow, cursorVisualCol] = buffer.visualCursor;
  const scrollVisualRow = buffer.visualScrollRow;

  const resolvedBorderColor = borderColor ?? theme.border.focused;
  const resolvedPrefix = prefix ?? (
    <Text color={theme.text.accent}>{'> '}</Text>
  );

  const columns = process.stdout.columns || 80;
  // Build the top border line: ─────── label ──
  // Label takes: 1 space + text + 1 space + 2 trailing dashes = label.length + 4
  const labelWidth = topRightLabel ? stringWidth(topRightLabel) + 4 : 0;
  const dashCount = Math.max(1, columns - labelWidth);
  const topBorderLine = topRightLabel
    ? `${'─'.repeat(dashCount)} ${topRightLabel} ${'─'.repeat(2)}`
    : '─'.repeat(columns);

  return (
    <Box flexDirection="column">
      <Text color={resolvedBorderColor} wrap="truncate-end">
        {topBorderLine}
      </Text>
      <Box
        borderStyle="single"
        borderTop={false}
        borderBottom={true}
        borderLeft={false}
        borderRight={false}
        borderColor={resolvedBorderColor}
      >
        {resolvedPrefix}
        <Box flexGrow={1} flexDirection="column">
          {buffer.text.length === 0 && placeholder ? (
            showCursor ? (
              <Text>
                {chalk.inverse(placeholder.slice(0, 1))}
                <Text color={theme.text.secondary}>{placeholder.slice(1)}</Text>
              </Text>
            ) : (
              <Text color={theme.text.secondary}>{placeholder}</Text>
            )
          ) : (
            linesToRender.map((lineText, idx) => {
              const absoluteVisualIndex = scrollVisualRow + idx;
              const isOnCursorLine = absoluteVisualIndex === cursorVisualRow;

              return (
                <Box key={idx} height={1}>
                  {renderLine({
                    lineText,
                    isOnCursorLine,
                    cursorCol: cursorVisualCol,
                    showCursor,
                    visualLineIndex: idx,
                    absoluteVisualIndex,
                    buffer,
                    scrollVisualRow,
                  })}
                </Box>
              );
            })
          )}
        </Box>
      </Box>
    </Box>
  );
};
