#!/usr/bin/env node
'use strict';
// Single hook entrypoint: node scripts/hook.js <limit|stop|session-start|prompt>
// Must never throw or exit non-zero.

const core = require('../lib/core');

async function main() {
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
      if (event === 'session-start') {
        try {
          require('../lib/fb-gateway-admin').ensureForHook();
        } catch (e) {
          core.logError(cwd, `gateway ensure: ${e && e.message ? e.message : e}`);
        }
      }
      if (event === 'prompt') {
        try {
          out = await require('../lib/fb-mode').handlePrompt(input, cwd);
        } catch (e) {
          core.logError(cwd, `fb-model: ${e && e.stack ? e.stack : e}`);
        }
      }
      if (!out) out = core.handleSessionOrPrompt(event, input);
    }
    if (out) process.stdout.write(JSON.stringify(out));
  } catch (err) {
    core.logError(cwd, `hook ${event}: ${err && err.stack ? err.stack : err}`);
  }
  process.exitCode = 0;
}

main().catch(() => {
  process.exitCode = 0;
});
