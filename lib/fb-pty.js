'use strict';
// Loads the terminal modules lazily (so the plugin still loads without them) and
// resolves the Freebuff command. Env overrides exist for tests (FB_AGENT_CMD / FB_AGENT_ARGS).

const fs = require('fs');
const os = require('os');
const path = require('path');
const core = require('./core');

const PLUGIN_DIR = path.resolve(__dirname, '..');
let cached = null;

// Returns { pty, Terminal }. Throws an Error with a one-line fix when a module is missing.
function loadDeps() {
  if (cached) return cached;
  let pty = null;
  for (const name of ['@lydell/node-pty', '@homebridge/node-pty-prebuilt-multiarch']) {
    try {
      pty = require(name);
      break;
    } catch (e) {
      // try the next one
    }
  }
  let Terminal = null;
  try {
    Terminal = require('@xterm/headless').Terminal;
  } catch (e) {
    // reported below
  }
  if (!pty || !Terminal) {
    const err = new Error(`fb needs its terminal modules. Run: npm install --prefix "${PLUGIN_DIR}"`);
    err.code = 'FB_DEPS_MISSING';
    throw err;
  }
  cached = { pty, Terminal };
  return cached;
}

// The command that starts Freebuff in the PTY (base args only; the daemon appends --cwd and --continue).
function freebuffCommand() {
  if (process.env.FB_AGENT_CMD) {
    let args = [];
    try {
      args = JSON.parse(process.env.FB_AGENT_ARGS || '[]');
    } catch (e) {
      args = [];
    }
    return { file: process.env.FB_AGENT_CMD, args: Array.isArray(args) ? args : [] };
  }
  if (process.platform === 'win32') {
    // 1. The Bun-compiled binary (tested: works in a PTY, no cmd.exe layer).
    const exe = path.join(core.freebuffHome(), 'freebuff.exe');
    if (fs.existsSync(exe)) return { file: exe, args: [] };
    // 2. The npm package's entry script run by node (tested). Avoids cmd.exe, whose quoting breaks on paths with spaces.
    const appData = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
    const entry = path.join(appData, 'npm', 'node_modules', 'freebuff', 'index.js');
    if (fs.existsSync(entry)) return { file: process.execPath, args: [entry] };
    // 3. Last resort: the .cmd shim through cmd.exe.
    return { file: 'cmd.exe', args: ['/d', '/c', 'freebuff'] };
  }
  return { file: 'freebuff', args: [] };
}

module.exports = { PLUGIN_DIR, loadDeps, freebuffCommand };
