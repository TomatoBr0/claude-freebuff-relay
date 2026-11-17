#!/usr/bin/env node
'use strict';
// Stand-in for the Freebuff TUI, used by test/run.js (set FB_AGENT_CMD=node, FB_AGENT_ARGS=["<this file>"]).
// It shows the input prompt, reads keystrokes from the PTY (bracketed paste + Enter submits),
// and writes chat-messages.json / run-state.json / log.jsonl like the real app does.
// Its reply contains a reasoning block and a tool output block that must never reach the user.
// FAKE_FB_NEVER_PROCESS=1 makes it log "session over" and never answer (stuck case).

const fs = require('fs');
const path = require('path');

const args = process.argv.slice(2);
const cwdIdx = args.indexOf('--cwd');
const cwd = cwdIdx >= 0 ? args[cwdIdx + 1] : process.cwd();
const home = process.env.RELAY_FREEBUFF_HOME;
const chatsRoot = path.join(home, 'projects', path.basename(path.resolve(cwd)), 'chats');
const neverProcess = process.env.FAKE_FB_NEVER_PROCESS === '1';

function isoName() {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

fs.mkdirSync(chatsRoot, { recursive: true });
const chatDir = path.join(chatsRoot, isoName());
fs.mkdirSync(chatDir, { recursive: true });
fs.writeFileSync(
  path.join(chatDir, 'run-state.json'),
  JSON.stringify({ sessionState: { fileContext: { projectRoot: path.resolve(cwd), cwd: path.resolve(cwd) } } })
);

const msgFile = path.join(chatDir, 'chat-messages.json');
const logFile = path.join(chatDir, 'log.jsonl');
let messages = [];

function log(msg, level = 'INFO') {
  fs.appendFileSync(logFile, JSON.stringify({ level, timestamp: new Date().toISOString(), msg }) + '\n');
}

function save() {
  fs.writeFileSync(msgFile, JSON.stringify(messages));
}

// Full-screen redraw, like the real TUI: state is 'idle' or 'busy'.
function draw(state) {
  const placeholder = state === 'busy' ? 'Add to the current task (/ for commands)' : 'Enter a coding task or / for commands';
  const status = state === 'busy' ? 'thinking...                                   ■ Esc' : '15.5K (1%)                    ✕ End session';
  process.stdout.write('\x1b[2J\x1b[H' + ['Fake Freebuff', '', status, '', placeholder, ''].join('\r\n') + '\r\n');
}

function submit(text) {
  if (!text.trim()) return;
  messages.push({ id: 'user-' + Date.now(), variant: 'user', content: text });
  save();
  if (neverProcess) {
    log('[chat-runtime] Freebuff session over; holding queued messages until rejoin');
    return;
  }
  log('[message-queue] Processing next message from queue');
  draw('busy');
  setTimeout(() => {
    messages.push({
      id: 'ai-' + Date.now(),
      variant: 'ai',
      content: '',
      blocks: [
        { type: 'text', content: 'SECRET THINKING', textType: 'reasoning' },
        { type: 'tool', toolName: 'read_files', input: { paths: ['hello.txt'] }, output: 'SECRET TOOL OUTPUT' },
        { type: 'text', content: 'FAKE REPLY: ' + text, textType: 'text' },
      ],
    });
    save();
    log('Runtime first output');
    setTimeout(() => {
      log('Main prompt finished');
      log('[message-queue] Processing lock released');
      draw('idle');
    }, 100);
  }, 1500);
}

if (process.stdin.isTTY) process.stdin.setRawMode(true);
process.stdin.setEncoding('utf8');
draw('idle');
let pending = '';
process.stdin.on('data', (chunk) => {
  const s = chunk.replace(/\x1b\[20[01]~/g, '');
  for (const ch of s) {
    if (ch === '\r' || ch === '\n') {
      const text = pending;
      pending = '';
      submit(text);
    } else if (ch >= ' ') {
      pending += ch;
      process.stdout.write(ch);
    }
  }
});
process.stdin.on('end', () => process.exit(0));
process.on('SIGTERM', () => process.exit(0));
