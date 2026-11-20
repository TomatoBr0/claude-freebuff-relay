---
description: Freebuff mode on|off|status — Freebuff answers your messages instead of Claude (works with Remote Control and while rate-limited)
argument-hint: on|off|status
allowed-tools: Bash(node:*)
---
!`node "${CLAUDE_PLUGIN_ROOT}/bin/claude-relay.js" fb-model $ARGUMENTS --cwd "$PWD"`

Repeat the line above to the user in one short sentence. Do nothing else.
