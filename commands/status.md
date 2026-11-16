---
description: Show claude-freebuff-relay state for this project
allowed-tools: Bash(node:*)
---
!`node "${CLAUDE_PLUGIN_ROOT}/bin/claude-relay.js" status --cwd "$PWD"`

Summarize the relay state above for the user in one or two sentences (mode, handoff time, expected reset).
