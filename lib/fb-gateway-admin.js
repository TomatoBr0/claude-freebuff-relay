'use strict';
// Lifecycle for lib/fb-gateway.js: start/stop/status, and install/uninstall into
// ~/.claude/settings.json (+ a hidden Windows login launcher).

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');
const gw = require('./fb-gateway');

const GATEWAY = path.join(__dirname, 'fb-gateway.js');
const BIN = path.join(__dirname, '..', 'bin', 'claude-relay.js');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function claudeDir() {
  return process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
}
function settingsPath() {
  return path.join(claudeDir(), 'settings.json');
}
function logPath() {
  return path.join(claudeDir(), 'fb-gateway.log');
}
function baseUrl() {
  return `http://127.0.0.1:${gw.port()}`;
}
function startupLauncher() {
  if (process.platform !== 'win32' || !process.env.APPDATA) return null;
  return path.join(process.env.APPDATA, 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup', 'claude-fb-gateway.vbs');
}

function envBlock() {
  return {
    ANTHROPIC_BASE_URL: baseUrl(),
    ANTHROPIC_CUSTOM_MODEL_OPTION: 'freebuff',
    ANTHROPIC_CUSTOM_MODEL_OPTION_NAME: 'Freebuff',
    ANTHROPIC_CUSTOM_MODEL_OPTION_DESCRIPTION: 'Free coding agent (Freebuff) via the local relay gateway',
  };
}

function info() {
  return new Promise((resolve) => {
    const r = http.get({ host: '127.0.0.1', port: gw.port(), path: '/__fb_gateway', timeout: 800 }, (res) => {
      let s = '';
      res.on('data', (c) => (s += c));
      res.on('end', () => {
        try {
          resolve(JSON.parse(s));
        } catch (e) {
          resolve(null);
        }
      });
    });
    r.on('timeout', () => r.destroy());
    r.on('error', () => resolve(null));
  });
}

// Starts the gateway detached (no window) unless one already answers.
async function start({ wait = true } = {}) {
  if (await gw.ping()) return { started: false };
  fs.mkdirSync(claudeDir(), { recursive: true });
  const fd = fs.openSync(logPath(), 'a');
  const child = spawn(process.execPath, [GATEWAY], {
    detached: true,
    stdio: ['ignore', fd, fd],
    windowsHide: true,
    env: process.env,
  });
  child.on('error', () => {});
  child.unref();
  fs.closeSync(fd);
  if (!wait) return { started: true };
  for (let i = 0; i < 40; i++) {
    await sleep(150);
    if (await gw.ping()) return { started: true };
  }
  throw new Error(`gateway did not come up on ${baseUrl()}; see ${logPath()}`);
}

async function stop() {
  const i = await info();
  if (!i || !i.pid) return false;
  try {
    process.kill(i.pid);
  } catch (e) {
    return false;
  }
  for (let n = 0; n < 30 && (await gw.ping(300)); n++) await sleep(100);
  return true;
}

function readSettings() {
  const p = settingsPath();
  if (!fs.existsSync(p)) return {};
  const raw = fs.readFileSync(p, 'utf8').replace(/^﻿/, '');
  return raw.trim() ? JSON.parse(raw) : {};
}

function writeSettings(obj) {
  const p = settingsPath();
  if (fs.existsSync(p)) fs.copyFileSync(p, p + '.bak-fb-gateway');
  fs.writeFileSync(p, JSON.stringify(obj, null, 2) + '\n');
}

function writeLauncher() {
  const f = startupLauncher();
  if (!f) return null;
  const q = (s) => s.replace(/"/g, '""');
  const cmd = `"${q(process.execPath)}" "${q(BIN)}" gateway start`;
  const vbs = `' claude-freebuff-relay: start the Freebuff model gateway at login (hidden)\r\n` +
    `CreateObject("WScript.Shell").Run "${q(cmd)}", 0, False\r\n`;
  fs.writeFileSync(f, vbs);
  return f;
}

// Removes our env vars from settings.json. Returns true if anything changed.
function removeSettingsEnv() {
  const s = readSettings();
  if (!s.env) return false;
  let changed = false;
  for (const k of Object.keys(envBlock())) {
    if (k in s.env) {
      delete s.env[k];
      changed = true;
    }
  }
  if (!changed) return false;
  if (!Object.keys(s.env).length) delete s.env;
  writeSettings(s);
  return true;
}

// Default install: gateway + login launcher only. Sessions opt in through `claude-fb`,
// because a global ANTHROPIC_BASE_URL turns off Remote Control (Claude Code >= 2.1.196).
// global=true also writes the env into settings.json so /model freebuff works everywhere.
async function install({ global = false } = {}) {
  if (!global) {
    await start();
    const removed = removeSettingsEnv();
    return { settings: settingsPath(), launcher: writeLauncher(), global: false, removed };
  }
  const s = readSettings();
  const env = Object.assign({}, s.env || {});
  const want = envBlock();
  if (env.ANTHROPIC_BASE_URL && env.ANTHROPIC_BASE_URL !== want.ANTHROPIC_BASE_URL) {
    throw new Error(`settings.json already sets ANTHROPIC_BASE_URL=${env.ANTHROPIC_BASE_URL}; not overwriting it.`);
  }
  // Start first: once the env var is in place, Claude Code needs the gateway up.
  await start();
  Object.assign(env, want);
  s.env = env;
  writeSettings(s);
  const launcher = writeLauncher();
  return { settings: settingsPath(), launcher, global: true };
}

async function uninstall() {
  const s = readSettings();
  if (s.env) {
    for (const k of Object.keys(envBlock())) delete s.env[k];
    if (!Object.keys(s.env).length) delete s.env;
    writeSettings(s);
  }
  const f = startupLauncher();
  if (f && fs.existsSync(f)) fs.unlinkSync(f);
  const stopped = await stop();
  return { settings: settingsPath(), stopped };
}

// Used by the SessionStart hook: if this session points at our gateway, make sure it runs.
function ensureForHook() {
  const url = process.env.ANTHROPIC_BASE_URL || '';
  if (url.replace(/\/$/, '') !== baseUrl()) return false;
  const child = spawn(process.execPath, [BIN, 'gateway', 'start'], { detached: true, stdio: 'ignore', windowsHide: true });
  child.on('error', () => {});
  child.unref();
  return true;
}

async function cli(sub) {
  switch (sub) {
    case 'run':
      gw.run();
      return;
    case 'start': {
      const r = await start();
      console.log(r.started ? `gateway started on ${baseUrl()}` : `gateway already running on ${baseUrl()}`);
      return;
    }
    case 'stop':
      console.log((await stop()) ? 'gateway stopped' : 'gateway was not running');
      return;
    case 'status': {
      const i = await info();
      const s = readSettings();
      const installed = !!(s.env && s.env.ANTHROPIC_BASE_URL === baseUrl());
      console.log(i ? `gateway: running on ${baseUrl()} (pid ${i.pid})` : `gateway: not running (${baseUrl()})`);
      console.log(`settings.json: ${installed ? 'installed' : 'not installed'} (${settingsPath()})`);
      const f = startupLauncher();
      if (f) console.log(`login launcher: ${fs.existsSync(f) ? f : 'none'}`);
      console.log(`log: ${logPath()}`);
      return;
    }
    case 'install': {
      const r = await install({ global: process.argv.includes('--global') });
      console.log(`Installed. Gateway running on ${baseUrl()}.`);
      if (r.launcher) console.log(`Starts at login via ${r.launcher}`);
      if (r.global) {
        console.log(`settings.json updated (backup: ${r.settings}.bak-fb-gateway).`);
        console.log('Restart Claude Code, then use: /model freebuff. Note: Remote Control is off while this is set.');
      } else {
        if (r.removed) console.log('Removed the global ANTHROPIC_BASE_URL from settings.json (Remote Control works again).');
        console.log('Run `claude-fb` to start Claude Code on Freebuff; normal `claude` keeps Remote Control.');
      }
      return;
    }
    case 'uninstall': {
      await uninstall();
      console.log('Removed the gateway env vars and login launcher; gateway stopped. Restart Claude Code.');
      return;
    }
    default:
      console.error('usage: claude-relay gateway <run|start|stop|status|install|uninstall>');
      process.exitCode = 1;
  }
}

module.exports = { cli, start, stop, info, install, uninstall, ensureForHook, envBlock, baseUrl };
