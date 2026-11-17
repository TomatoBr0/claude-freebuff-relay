---
description: Send a message to Freebuff (runs in a background Freebuff session) and show its reply
argument-hint: <message>
allowed-tools: Bash(node:*)
---
!`node "${CLAUDE_PLUGIN_ROOT}/bin/fb.js" --cwd "$PWD" $ARGUMENTS`

Show Freebuff's reply above to the user, trimmed of noise but kept verbatim-ish. Do not redo the work yourself. If the output says Freebuff is stuck or waiting, tell the user to run `! fb screen` and then `! fb keys "\r"`, or `! fb new`.
