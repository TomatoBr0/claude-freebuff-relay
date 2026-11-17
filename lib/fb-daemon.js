'use strict';
// fb daemon: one per project folder. It keeps a Freebuff TUI running inside a PTY, types
// messages into it, reads the replies from Freebuff's chat files, keeps a screen buffer for
// diagnostics, and serves requests over a local named pipe (Windows) or unix socket.
//
// Run by lib/fb-client.js:  node lib/fb-daemon.js --cwd <dir> [--continue[=<id>]]
// Env: FB_IDLE_MIN (30), FB_ASK_TIMEOUT_SEC (900), FB_STUCK_SEC (45).

const fs = require('fs');
const net = require('net');
const path = require('path');
const core = require('./core');
const chat = require('./fb-chat');
const proto = require('./fb-protocol');
const agent = require('./fb-pty');

const COLS = 120;
const ROWS = 40;
const SCROLLBACK = 1000;
const POLL_MS = 500;
// Idle input box reads "Enter a coding task"; while Freebuff works the status line shows
// "thinking..." with "■ Esc" and the placeholder becomes "Add to the current task".
const READY_TEXT = /Enter a coding task/;
const BUSY_TEXT = /thinking\.\.\.|■ Esc|Add to the current task/;
const BP_START = '\x1b[200~';
const BP_END = '\x1b[201~';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function envNum(name, dflt) {
  const v = parseFloat(process.env[name]);
  return Number.isFinite(v) && v > 0 ? v : dflt;
}

class Daemon {
  constructor({ cwd, continueArgs }) {
    this.cwd = path.resolve(cwd);
    this.continueArgs = continueArgs || [];
    this.endpoint = proto.endpointFor(this.cwd);
    this.idleMs = envNum('FB_IDLE_MIN', 30) * 60000;
    this.stuckMs = envNum('FB_STUCK_SEC', 45) * 1000;
    this.askTimeoutSec = envNum('FB_ASK_TIMEOUT_SEC', 900);
    this.startedAt = Date.now();
    this.lastActivity = Date.now();
    this.lastOutputAt = Date.now();
    this.asking = false;
    this.exited = false;
    this.ready = false;
    this.lastAsk = null;
    this.currentChat = null;
    this.closing = false;
    this.queue = Promise.resolve();
  }

  log(msg) {
    try {
      core.ensureRelayDir(this.cwd);
      fs.appendFileSync(path.join(core.relayDir(this.cwd), 'fb-daemon.log'), `[${new Date().toISOString()}] ${msg}\n`);
    } catch (e) {
      // logging must never take the daemon down
    }
  }

  async alreadyRunning() {
    const sock = await proto.connect(this.endpoint, 1500);
    if (sock) sock.destroy();
    return !!sock;
  }

  async start() {
    if (await this.alreadyRunning()) {
      this.log('another daemon already serves this folder; exiting');
      process.exit(0);
    }
    const { pty, Terminal } = agent.loadDeps();
    this.term = new Terminal({ cols: COLS, rows: ROWS, scrollback: SCROLLBACK, allowProposedApi: true });
    const cmd = agent.freebuffCommand();
    const args = cmd.args.concat(['--cwd', this.cwd], this.continueArgs);
    this.proc = pty.spawn(cmd.file, args, {
      name: 'xterm-256color',
      cols: COLS,
      rows: ROWS,
      cwd: this.cwd,
      env: process.env,
    });
    this.log(`spawned ${cmd.file} ${args.join(' ')} (pid ${this.proc.pid})`);
    this.proc.onData((d) => {
      this.lastOutputAt = Date.now();
      this.term.write(d);
    });
    this.proc.onExit(({ exitCode }) => {
      this.exited = true;
      this.log(`freebuff exited with code ${exitCode}`);
      setTimeout(() => this.shutdown('freebuff exited'), 1500);
    });

    if (process.platform !== 'win32') {
      try {
        fs.unlinkSync(this.endpoint); // stale socket from a crashed daemon
      } catch (e) {
        // none
      }
    }
    this.server = net.createServer((sock) => this.onConnection(sock));
    this.server.on('error', (e) => {
      this.log('server error: ' + e.message);
      this.shutdown('server error');
    });
    await new Promise((resolve, reject) => {
      this.server.once('error', reject);
      this.server.listen(this.endpoint, () => {
        this.server.removeAllListeners('error');
        this.server.on('error', (e) => {
          this.log('server error: ' + e.message);
          this.shutdown('server error');
        });
        resolve();
      });
    });
    this.writePidFile();
    this.idleTimer = setInterval(() => this.checkIdle(), 30000);
    this.log(`listening on ${this.endpoint}`);
  }

  writePidFile() {
    try {
      core.ensureRelayDir(this.cwd);
      fs.writeFileSync(
        path.join(core.relayDir(this.cwd), 'fb-daemon.json'),
        JSON.stringify({
          pid: process.pid,
          freebuffPid: this.proc ? this.proc.pid : null,
          endpoint: this.endpoint,
          cwd: this.cwd,
          startedAt: new Date(this.startedAt).toISOString(),
        }, null, 2)
      );
    } catch (e) {
      this.log('could not write fb-daemon.json: ' + e.message);
    }
  }

  removePidFile() {
    const file = path.join(core.relayDir(this.cwd), 'fb-daemon.json');
    try {
      const o = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (o.pid === process.pid) fs.unlinkSync(file);
    } catch (e) {
      // nothing to remove
    }
  }

  shutdown(reason) {
    if (this.closing) return;
    this.closing = true;
    this.log('shutdown: ' + reason);
    try {
      if (this.proc && !this.exited) this.proc.kill();
    } catch (e) {
      // already gone
    }
    try {
      if (this.server) this.server.close();
    } catch (e) {
      // already closed
    }
    if (process.platform !== 'win32') {
      try {
        fs.unlinkSync(this.endpoint);
      } catch (e) {
        // none
      }
    }
    this.removePidFile();
    setTimeout(() => process.exit(0), 200);
  }

  checkIdle() {
    if (!this.asking && Date.now() - this.lastActivity > this.idleMs) this.shutdown('idle');
  }

  touch() {
    this.lastActivity = Date.now();
  }

  // ---- screen ----

  flush() {
    return new Promise((resolve) => this.term.write('', resolve));
  }

  // Last n non-empty rows of the rolling buffer (scrollback included), trailing spaces removed.
  screenLines(n) {
    const b = this.term.buffer.active;
    const out = [];
    for (let i = 0; i < b.length; i++) {
      const line = b.getLine(i);
      out.push(line ? line.translateToString(true).replace(/\s+$/, '') : '');
    }
    while (out.length && !out[out.length - 1]) out.pop();
    return out.slice(-Math.max(1, n || 40));
  }

  async screenSnapshot(n) {
    await this.flush();
    return this.screenLines(n);
  }

  // The visible rows only (what a person would see now), not scrollback.
  viewportText() {
    const b = this.term.buffer.active;
    const rows = [];
    for (let i = 0; i < ROWS; i++) {
      const line = b.getLine(b.baseY + i);
      rows.push(line ? line.translateToString(true) : '');
    }
    return rows.join('\n');
  }

  // Input box visible, not busy, and output quiet for a second.
  async waitReady(maxMs) {
    const t0 = Date.now();
    while (Date.now() - t0 < maxMs) {
      await this.flush();
      const text = this.viewportText();
      if (READY_TEXT.test(text) && !BUSY_TEXT.test(text) && Date.now() - this.lastOutputAt >= 1000) return true;
      if (this.exited) return false;
      await sleep(300);
    }
    return false;
  }

  // Busy by the TUI's own indicators (screen is flushed first).
  async isBusy() {
    await this.flush();
    return BUSY_TEXT.test(this.viewportText());
  }

  // ---- requests ----

  onConnection(sock) {
    const send = (obj) => {
      if (!sock.destroyed) sock.write(proto.encode(obj));
    };
    sock.on('error', () => {});
    const feed = proto.lineSplitter((line) => {
      const req = proto.parseFrame(line);
      this.handle(req, send)
        .catch((e) => send({ type: 'error', message: e && e.message ? e.message : String(e) }))
        .then(() => {
          send({ type: 'end' });
          sock.end();
        });
    });
    sock.on('data', feed);
  }

  runExclusive(fn) {
    const p = this.queue.then(fn, fn);
    this.queue = p.catch(() => {});
    return p;
  }

  async handle(req, send) {
    this.touch();
    switch (req.op) {
      case 'ask':
        return this.runExclusive(() =>
          this.ask(String(req.text == null ? '' : req.text), Number(req.timeoutSec) || this.askTimeoutSec, send)
        );
      case 'screen':
        send({ type: 'screen', lines: await this.screenSnapshot(Number(req.lines) || 40) });
        return;
      case 'keys': {
        if (this.exited) throw new Error('Freebuff is not running');
        this.proc.write(String(req.data == null ? '' : req.data));
        await sleep(400);
        send({ type: 'screen', lines: await this.screenSnapshot(Number(req.lines) || 40) });
        return;
      }
      case 'status':
        send(await this.status());
        return;
      case 'stop':
        send({ type: 'ok', message: 'stopping' });
        setTimeout(() => this.shutdown('stop requested'), 150);
        return;
      default:
        send({ type: 'error', message: `unknown op: ${req.op}` });
    }
  }

  async status() {
    return {
      type: 'status',
      running: !this.exited,
      pid: process.pid,
      freebuffPid: this.proc ? this.proc.pid : null,
      cwd: this.cwd,
      startedAt: new Date(this.startedAt).toISOString(),
      uptimeSec: Math.round((Date.now() - this.startedAt) / 1000),
      idleExitMin: Math.round(this.idleMs / 60000),
      ready: this.ready,
      busy: !!this.busy,
      asking: this.asking,
      lastAsk: this.lastAsk ? new Date(this.lastAsk.sendAt).toISOString() : null,
      chat: this.currentChat ? this.currentChat.name : null,
    };
  }

  // Types the message, then follows Freebuff's chat files until the reply is complete.
  async ask(text, timeoutSec, send) {
    const t0 = Date.now();
    const deadline = t0 + timeoutSec * 1000;
    this.asking = true;
    try {
      if (!text.trim()) {
        send({ type: 'error', message: 'empty message' });
        return;
      }
      if (this.exited) {
        send(await this.problem('stuck', 'Freebuff is not running.'));
        return;
      }
      const ready = await this.waitReady(this.ready ? 20000 : 60000);
      if (!ready) {
        send(await this.problem('stuck', 'Freebuff did not show its input box (login, rejoin or ad screen?). Nothing was sent.'));
        return;
      }
      this.ready = true;
      const sendAt = Date.now();
      this.lastAsk = { text, sendAt };
      this.proc.write(BP_START + text.replace(/\r/g, '') + BP_END);
      await sleep(300);
      this.proc.write('\r');
      this.log(`asked (${text.length} chars)`);

      const outcome = await this.follow(text, sendAt, deadline, send);
      const ms = Date.now() - t0;
      if (outcome === 'done') {
        send({ type: 'done', ms });
      } else {
        send(await this.problem(outcome, this.reasonFor(outcome)));
      }
      this.log(`ask ended: ${outcome} after ${ms} ms`);
    } finally {
      this.asking = false;
      this.touch();
    }
  }

  reasonFor(outcome) {
    return {
      stuck: 'Freebuff accepted the message but never started on it (session over, queued, or paused). Your message may still be queued.',
      timeout: 'Timed out waiting for Freebuff.',
      'no-reply': 'Freebuff finished without writing a reply to the chat.',
      exited: 'Freebuff exited while answering.',
    }[outcome] || outcome;
  }

  async problem(type, reason) {
    return { type, reason, screen: await this.screenSnapshot(25) };
  }

  // Polls the chat files and emits new events. Returns the outcome name.
  async follow(text, sendAt, deadline, send) {
    const emitted = new Set();
    let lastSig = '';
    let lastChange = Date.now();
    let found = null;
    let finishedAt = null;
    for (;;) {
      await sleep(POLL_MS);
      if (this.exited) return 'exited';
      if (!found) {
        found = chat.findChatForMessage(this.cwd, text, sendAt);
        if (found) {
          this.currentChat = found;
          this.log(`chat ${found.name}`);
        }
      }
      let messages = null;
      let sig = { finished: false, processing: false, sessionOver: false, paused: false, mtime: 0 };
      if (found) {
        messages = core.readChatMessages(found.file);
        let size = 0;
        let mtime = 0;
        try {
          const st = fs.statSync(found.file);
          size = st.size;
          mtime = st.mtimeMs;
        } catch (e) {
          // file may be rewritten
        }
        const s = `${size}:${mtime}`;
        if (s !== lastSig) {
          lastSig = s;
          lastChange = Date.now();
        }
        sig = chat.logSignals(found.dir, sendAt);
      }
      const idx = messages ? chat.findUserIndex(messages, text, sendAt) : -1;
      if (idx >= 0) {
        for (const ev of chat.collectEvents(messages, idx, emitted, sig.finished)) send(ev);
      }
      const quiet = Date.now() - lastChange;
      const logQuiet = Date.now() - (sig.mtime || 0);
      const last = messages && messages.length ? messages[messages.length - 1] : null;
      const replyPending = idx < 0 || !last || last.variant === 'user';
      const busy = await this.isBusy();
      this.busy = busy;
      if (sig.finished && finishedAt == null) finishedAt = Date.now();

      // Done: the log says the prompt finished, the chat has settled, and the screen is no
      // longer busy (capped at 10s after the log marker, in case the screen lags).
      const screenIdle = !busy || (finishedAt != null && Date.now() - finishedAt >= 10000);
      if (idx >= 0 && sig.finished && !replyPending && quiet >= 1000 && screenIdle) {
        return 'done';
      }
      if (idx >= 0 && sig.finished && replyPending && quiet >= 8000) {
        return 'no-reply';
      }
      // Fallback when the log carries no markers: the reply has stopped changing for a while.
      if (idx >= 0 && !sig.finished && !replyPending && quiet >= 20000 && logQuiet >= 20000) {
        return 'done';
      }
      if (!sig.processing && replyPending && Date.now() - sendAt > this.stuckMs) {
        return 'stuck';
      }
      if (Date.now() > deadline) {
        if (idx >= 0) for (const ev of chat.collectEvents(messages, idx, emitted, true)) send(ev);
        return 'timeout';
      }
    }
  }
}

async function main(argv) {
  const get = (name) => {
    const i = argv.indexOf(name);
    return i >= 0 ? argv[i + 1] : null;
  };
  const cwd = get('--cwd') || process.cwd();
  const continueArgs = argv.find((a) => a === '--continue' || a.startsWith('--continue='));
  const cont = continueArgs
    ? continueArgs.includes('=')
      ? ['--continue', continueArgs.slice(continueArgs.indexOf('=') + 1)]
      : ['--continue']
    : [];
  const d = new Daemon({ cwd: proto.toNativePath(cwd), continueArgs: cont });
  try {
    await d.start();
  } catch (e) {
    d.log('start failed: ' + (e && e.stack ? e.stack : e));
    process.exit(1);
  }
}

if (require.main === module) {
  main(process.argv.slice(2));
}

module.exports = { Daemon };
