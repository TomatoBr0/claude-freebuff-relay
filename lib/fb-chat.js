'use strict';
// Reads Freebuff's own chat files (the reliable output channel): finds the chat that holds
// our message, reads its log for completion and queue signals, and turns new messages
// into events. Reasoning and tool output are never returned.

const fs = require('fs');
const path = require('path');
const core = require('./core');

const LOG_TAIL_BYTES = 512 * 1024;
const TOOL_ARG_MAX = 120;

function chatsRoot(cwd) {
  return path.join(core.freebuffHome(), 'projects', path.basename(path.resolve(cwd)), 'chats');
}

// Newest first (chat dir names are ISO timestamps).
function listChatDirs(cwd) {
  let names = [];
  try {
    names = fs.readdirSync(chatsRoot(cwd));
  } catch (e) {
    return [];
  }
  return names
    .sort()
    .reverse()
    .map((name) => {
      const dir = path.join(chatsRoot(cwd), name);
      return { name, dir, file: path.join(dir, 'chat-messages.json') };
    });
}

function isReasoning(b) {
  return !!(b && (b.thinkingId || b.textType === 'reasoning' || b.textType === 'thinking'));
}

// Index of the newest user message sent at or after sinceMs (ids carry a ms timestamp).
// Messages without a parsable id are matched by their text.
function findUserIndex(messages, text, sinceMs) {
  const want = String(text == null ? '' : text).trim();
  if (!Array.isArray(messages)) return -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (!m || m.variant !== 'user') continue;
    const ms = core.messageMs(m);
    if (ms != null) {
      if (sinceMs == null || ms >= sinceMs - 2000) return i;
      continue;
    }
    if (core.userText(m) === want) return i;
  }
  return -1;
}

// The newest project chat (checking the six newest dirs) that holds our message.
function findChatForMessage(cwd, text, sinceMs) {
  for (const c of listChatDirs(cwd).slice(0, 6)) {
    if (!core.chatBelongsToProject(c.dir, cwd)) continue;
    const msgs = core.readChatMessages(c.file);
    if (msgs && findUserIndex(msgs, text, sinceMs) >= 0) return c;
  }
  return null;
}

// Parsed log entries {ts, msg} from the tail of log.jsonl. Lines are JSON; plain "ts LEVEL msg" also accepted.
function readLogEntries(dir) {
  const file = path.join(dir, 'log.jsonl');
  let fd;
  try {
    fd = fs.openSync(file, 'r');
  } catch (e) {
    return [];
  }
  try {
    const size = fs.fstatSync(fd).size;
    const len = Math.min(size, LOG_TAIL_BYTES);
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, size - len);
    let lines = buf.toString('utf8').split('\n');
    if (size > len) lines = lines.slice(1); // first line may be cut
    const out = [];
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const o = JSON.parse(line);
        out.push({ ts: Date.parse(o.timestamp), msg: String(o.msg || '') });
        continue;
      } catch (e) {
        // not JSON
      }
      const m = line.match(/^(\S+)\s+\w+\s+(.*)$/);
      if (m) out.push({ ts: Date.parse(m[1]), msg: m[2] });
    }
    return out;
  } finally {
    fs.closeSync(fd);
  }
}

// Signals for one ask, from log entries at or after sinceMs.
function logSignals(dir, sinceMs) {
  const sig = { finished: false, processing: false, sessionOver: false, paused: false, mtime: 0 };
  try {
    sig.mtime = fs.statSync(path.join(dir, 'log.jsonl')).mtimeMs;
  } catch (e) {
    // no log yet
  }
  for (const e of readLogEntries(dir)) {
    if (e.ts != null && !Number.isNaN(e.ts) && sinceMs != null && e.ts < sinceMs - 1000) continue;
    const m = e.msg;
    if (/Main prompt finished|Processing lock released/.test(m)) sig.finished = true;
    if (/Processing next message from queue|Sending message with sdk run config|Runtime first output/.test(m)) {
      sig.processing = true;
    }
    if (/session over/i.test(m)) sig.sessionOver = true;
    if (/queue blocked|user paused/i.test(m)) sig.paused = true;
  }
  return sig;
}

// The short argument shown on a tool line: a path, a command, or a search pattern.
function toolArg(input) {
  const base = core.toolArg(input);
  if (base || !input || typeof input !== 'object') return base;
  if (Array.isArray(input.paths) && input.paths.length) return core.toolArg({ path: input.paths.join(', ') });
  const alt = input.pattern || input.query;
  return typeof alt === 'string' ? core.toolArg({ path: alt }) : '';
}

// New events for messages from fromIdx on. Tool lines are emitted as soon as they appear.
// Text is emitted only once its message is complete (a later message exists, or final).
// `emitted` holds keys already sent, so calling this repeatedly is safe.
function collectEvents(messages, fromIdx, emitted, final) {
  const out = [];
  if (!Array.isArray(messages)) return out;
  for (let i = Math.max(0, fromIdx); i < messages.length; i++) {
    const m = messages[i];
    if (!m || m.variant !== 'ai') continue;
    const complete = !!final || i < messages.length - 1;
    const blocks = Array.isArray(m.blocks) ? m.blocks : [];
    blocks.forEach((b, bi) => {
      const key = `${m.id}#${bi}`;
      if (!b || typeof b !== 'object' || emitted.has(key)) return;
      if (b.type === 'tool') {
        // Follow-up suggestions stream in; wait for the finished message to get the list.
        if (b.toolName === 'suggest_followups' && !complete && !(b.input && Array.isArray(b.input.followups) && b.output)) return;
        emitted.add(key);
        const ev = { type: 'tool', name: b.toolName || 'tool', arg: toolArg(b.input) };
        const fu = b.input && Array.isArray(b.input.followups) ? b.input.followups : null;
        if (fu) ev.followups = fu.filter((f) => f && (f.label || f.prompt)).map((f) => ({ label: String(f.label || ''), prompt: String(f.prompt || '') }));
        out.push(ev);
      } else if (b.type === 'text') {
        if (isReasoning(b)) {
          emitted.add(key);
          return;
        }
        if (!complete) return;
        emitted.add(key);
        const t = typeof b.content === 'string' ? b.content.trim() : '';
        if (t) out.push({ type: 'text', text: t });
      }
    });
    // Older chats: a plain string content and no blocks.
    if (!blocks.length && typeof m.content === 'string' && complete) {
      const key = `${m.id}#content`;
      if (!emitted.has(key)) {
        emitted.add(key);
        const t = m.content.trim();
        if (t) out.push({ type: 'text', text: t });
      }
    }
  }
  return out;
}

// One event as plain text (no ANSI). Used by the CLI and the MCP tool.
function formatEvent(ev) {
  if (!ev) return '';
  if (ev.type === 'text') return ev.text + '\n\n';
  if (ev.type === 'tool' && Array.isArray(ev.followups)) {
    if (!ev.followups.length) return '';
    return (
      '\nSuggested next steps:\n' +
      ev.followups.map((f, i) => `  ${i + 1}. ${f.label || f.prompt}${f.label && f.prompt ? ' — ' + f.prompt : ''}`).join('\n') +
      '\n'
    );
  }
  if (ev.type === 'tool') return `  → ${ev.name}${ev.arg ? ' ' + ev.arg : ''}\n`;
  if (ev.type === 'info' || ev.type === 'hint') return `[fb] ${ev.text}\n`;
  return '';
}

module.exports = {
  chatsRoot,
  listChatDirs,
  findUserIndex,
  findChatForMessage,
  readLogEntries,
  logSignals,
  collectEvents,
  formatEvent,
  readMessages: core.readChatMessages,
  toolArg,
};
