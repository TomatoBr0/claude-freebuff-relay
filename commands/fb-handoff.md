---
description: Hand this task off to Freebuff now (writes HANDOFF.md; Freebuff stays inside Claude Code)
allowed-tools: Bash(node:*)
---
!`node "${CLAUDE_PLUGIN_ROOT}/bin/claude-relay.js" handoff --cwd "$PWD"`

Briefly confirm to the user that the handoff is done: no Freebuff window was opened; they can keep working from Claude Code with `/fb <message>` (or the `freebuff_ask` tool), and Claude will pick up Freebuff's work automatically once the limit resets.
