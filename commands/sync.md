---
description: Pull Freebuff's recent work back into this Claude session
allowed-tools: Bash(node:*)
---
!`node "${CLAUDE_PLUGIN_ROOT}/bin/claude-relay.js" sync --cwd "$PWD"`

Read the output above, which is Freebuff's activity log plus the current git state. Briefly tell the user what Freebuff did, review the changes, and continue the work.
