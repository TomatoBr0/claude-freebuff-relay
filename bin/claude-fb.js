#!/usr/bin/env node
'use strict';
// claude-fb: start Claude Code through the local Freebuff gateway with model freebuff.
// Only this session gets ANTHROPIC_BASE_URL, so normal `claude` sessions keep Remote Control.
// Extra arguments go to claude (e.g. `claude-fb -c`, `claude-fb --model opus`).

const { spawn } = require('child_process');
const admin = require('../lib/fb-gateway-admin');

function quote(a) {
  return /[\s"&|<>^()%!]/.test(a) ? `"${a.replace(/"/g, '\\"')}"` : a;
}

async function main() {
  try {
    await admin.start();
  } catch (e) {
    console.error('[claude-fb] ' + e.message);
    process.exit(1);
  }
  const env = Object.assign({}, process.env, admin.envBlock());
  const args = process.argv.slice(2);
  if (!args.includes('--model')) args.unshift('--model', 'freebuff');
  const win = process.platform === 'win32';
  const child = spawn('claude', win ? args.map(quote) : args, { stdio: 'inherit', env, shell: win });
  child.on('error', (e) => {
    console.error('[claude-fb] could not start claude: ' + e.message);
    process.exit(1);
  });
  child.on('exit', (code) => process.exit(code == null ? 1 : code));
}

main();
