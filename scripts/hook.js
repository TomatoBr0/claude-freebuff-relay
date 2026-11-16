#!/usr/bin/env node
'use strict';
// Single hook entrypoint: node scripts/hook.js <limit|stop|session-start|prompt>
// Must never throw or exit non-zero.

const core = require('../lib/core');

function main() {
  const event = process.argv[2] || '';
  const input = core.readStdinJson();
  const cwd = core.resolveCwd(input);
  try {
    let out = null;
    if (event === 'limit') {
      core.handleLimit(input);
    } else if (event === 'stop') {
      core.handleStop(input);
    } else if (event === 'session-start' || event === 'prompt') {
      out = core.handleSessionOrPrompt(event, input);
    }
    if (out) process.stdout.write(JSON.stringify(out));
  } catch (err) {
    core.logError(cwd, `hook ${event}: ${err && err.stack ? err.stack : err}`);
  }
  process.exitCode = 0;
}

try {
  main();
} catch (err) {
  process.exitCode = 0;
}
