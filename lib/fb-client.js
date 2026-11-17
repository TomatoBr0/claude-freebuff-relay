'use strict';
// Client side of the fb bridge: starts the per-folder daemon when needed and talks to it.
// Used by bin/fb.js and lib/fb-mcp.js.

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const core = require('./core');
const proto = require('./fb-protocol');
const agent = require('./fb-pty');

const DAEMON = path.join(__dirname, 'fb-daemon.js');
const FINAL = new Set(['done', 'stuck', 'timeout', 'no-reply', 'exited', 'error']);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function notRunning() {
  const e = new Error('no Freebuff session is running for this folder');
  e.code = 'FB_NOT_RUNNING';
  return e;
}

// Sends one request. onEvent is called for each frame until the daemon sends 'end'.
// Resolves with every frame received (the last one is the outcome for ask).
async function request(cwd, req, onEvent) {
  const sock = await proto.connect(proto.endpointFor(cwd), 1500);
  if (!sock) throw notRunning();
  return new Promise((resolve, reject) => {
    const frames = [];
    let finished = false;
    const finish = (err) => {
      if (finished) return;
      finished = true;
      if (err) reject(err);
      else resolve(frames);
    };
    const feed = proto.lineSplitter((line) => {
      const ev = proto.parseFrame(line);
      if (ev.type === 'end') {
        sock.end();
        return finish();
      }
      frames.push(ev);
      if (onEvent) onEvent(ev);
    });
    sock.on('data', feed);
    sock.on('error', (e) => finish(e));
    sock.on('close', () => finish());
    sock.write(proto.encode(req));
  });
}

async function status(cwd) {
  try {
    const frames = await request(cwd, { op: 'status' });
    return frames.find((f) => f.type === 'status') || null;
  } catch (e) {
    return null;
  }
}

// Starts the daemon detached if needed. Resolves { started, status }.
async function ensureDaemon(cwd, { continueArgs = [] } = {}) {
  const st = await status(cwd);
  if (st) return { started: false, status: st };
  agent.loadDeps(); // fail fast with the install hint before spawning anything
  const child = spawn(process.execPath, [DAEMON, '--cwd', cwd].concat(continueArgs), {
    cwd,
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
    env: process.env,
  });
  child.on('error', () => {});
  child.unref();
  const t0 = Date.now();
  while (Date.now() - t0 < 30000) {
    await sleep(250);
    const s = await status(cwd);
    if (s) return { started: true, status: s };
  }
  throw new Error(`the Freebuff session did not start. See ${path.join(core.relayDir(cwd), 'fb-daemon.log')}`);
}

// Sends a message and follows the reply. Resolves { ok, outcome, events, final }.
async function ask(cwd, text, { timeoutSec, continueArgs, onStart, onEvent } = {}) {
  const { started } = await ensureDaemon(cwd, { continueArgs });
  if (started && onStart) onStart();
  const events = [];
  const frames = await request(cwd, { op: 'ask', text, timeoutSec }, (ev) => {
    if (FINAL.has(ev.type)) return;
    if (ev.type === 'text' || ev.type === 'tool' || ev.type === 'user' || ev.type === 'hint') {
      events.push(ev);
      if (onEvent) onEvent(ev);
    }
  });
  const final = frames.find((f) => FINAL.has(f.type)) || { type: 'error', message: 'no outcome from the daemon' };
  return { ok: final.type === 'done', outcome: final.type, final, events };
}

async function screen(cwd, lines) {
  const frames = await request(cwd, { op: 'screen', lines });
  const f = frames.find((x) => x.type === 'screen');
  return f ? f.lines : [];
}

async function keys(cwd, data) {
  const frames = await request(cwd, { op: 'keys', data, lines: 25 });
  const f = frames.find((x) => x.type === 'screen');
  if (!f) throw new Error('no screen returned');
  return f.lines;
}

async function stop(cwd) {
  try {
    await request(cwd, { op: 'stop' });
  } catch (e) {
    if (e.code === 'FB_NOT_RUNNING') return false;
    throw e;
  }
  // Wait for the endpoint to go away so a following start is fresh.
  for (let i = 0; i < 40; i++) {
    if (!(await proto.connect(proto.endpointFor(cwd), 300))) break;
    await sleep(125);
  }
  return true;
}

// Stops any session here and starts a fresh one.
async function newSession(cwd) {
  await stop(cwd);
  return ensureDaemon(cwd);
}

function pidFile(cwd) {
  return path.join(core.relayDir(cwd), 'fb-daemon.json');
}

function readPidInfo(cwd) {
  try {
    return JSON.parse(fs.readFileSync(pidFile(cwd), 'utf8'));
  } catch (e) {
    return null;
  }
}

module.exports = {
  request,
  status,
  ensureDaemon,
  ask,
  screen,
  keys,
  stop,
  newSession,
  readPidInfo,
  notRunning,
};
