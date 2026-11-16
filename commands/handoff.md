---
description: Hand this task off to Freebuff now (writes HANDOFF.md and opens Freebuff)
allowed-tools: Bash(node:*)
---
!`node "${CLAUDE_PLUGIN_ROOT}/bin/claude-relay.js" handoff --cwd "$PWD"`

Briefly confirm to the user that the handoff is done: Freebuff was opened in a new terminal, the prompt to paste is on the clipboard, and that Claude will pick up Freebuff's work automatically once the limit resets.
