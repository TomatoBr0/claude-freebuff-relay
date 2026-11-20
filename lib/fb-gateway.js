#!/usr/bin/env node
'use strict';
// Local Anthropic-API gateway that makes Freebuff selectable as a Claude Code model.
//
//   ANTHROPIC_BASE_URL=http://127.0.0.1:47823  +  /model freebuff
//
// Requests whose `model` starts with "freebuff" go to the hidden per-project Freebuff
// session (the same one /fb and freebuff_ask use) and come back as a normal streamed
// assistant message. Everything else is passed through to Anthropic byte for byte, with
// Authorization / anthropic-beta untouched, so a claude.ai login keeps working.

const http = require('http');
const https = require('https');
const os = require('os');
const path = require('path');
const { URL } = require('url');

const DEFAULT_PORT = 47823;
const UPSTREAM = new URL(process.env.FB_GATEWAY_UPSTREAM || 'https://api.anthropic.com');
// Background requests (titles, summaries) carry no tools; keep them off Freebuff.
const BG_MODEL = process.env.FB_GATEWAY_BG_MODEL || 'claude-haiku-4-5';
const PING_MS = 10000;

function port() {
  return Number(process.env.FB_GATEWAY_PORT) || DEFAULT_PORT;
}

function log(msg) {
  if (process.env.FB_GATEWAY_QUIET === '1') return;
  process.stderr.write(`[fb-gateway ${new Date().toISOString()}] ${msg}\n`);
}

function isFreebuffModel(model) {
  return typeof model === 'string' && /^freebuff/i.test(model.trim());
}

function systemText(system) {
  if (typeof system === 'string') return system;
  if (Array.isArray(system)) return system.map((b) => (b && typeof b.text === 'string' ? b.text : '')).join('\n');
  return '';
}

function messageTexts(messages) {
  const out = [];
  for (const m of Array.isArray(messages) ? messages : []) {
    if (!m) continue;
    if (typeof m.content === 'string') out.push(m.content);
    else if (Array.isArray(m.content)) for (const b of m.content) if (b && typeof b.text === 'string') out.push(b.text);
  }
  return out.join('\n');
}

// Claude Code states "Primary working directory: <dir>" in the system prompt or, in newer
// versions, in an environment reminder inside the first user message.
function projectDir(body) {
  const sys = systemText(body.system) + '\n' + messageTexts(body.messages);
  const m = sys.match(/Primary working directory:\s*([^\r\n<]+)/i) || sys.match(/Working directory:\s*([^\r\n<]+)/i);
  const raw = (m && m[1].trim()) || process.env.FB_GATEWAY_CWD || os.homedir();
  const proto = require('./fb-protocol');
  return path.resolve(proto.toNativePath(raw.replace(/^["'`]|["'`]$/g, '')));
}

function stripReminders(s) {
  return String(s)
    .replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '')
    .replace(/<local-command-(stdout|stderr|caveat)>[\s\S]*?<\/local-command-\1>/g, '')
    .replace(/<command-(name|message|args)>[\s\S]*?<\/command-\1>/g, '')
    .replace(/<pasted_content[^>]*>/g, '')
    .replace(/<\/pasted_content[^>]*>/g, '')
    .trim();
}

// The newest user turn, as plain text. Freebuff keeps its own conversation state.
function latestUserText(messages) {
  if (!Array.isArray(messages)) return '';
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (!m || m.role !== 'user') continue;
    let text = '';
    if (typeof m.content === 'string') text = m.content;
    else if (Array.isArray(m.content)) {
      text = m.content
        .filter((b) => b && b.type === 'text' && typeof b.text === 'string')
        .map((b) => b.text)
        .join('\n');
    }
    text = stripReminders(text);
    if (text) return text;
  }
  return '';
}

function turnText(m) {
  if (!m) return '';
  if (typeof m.content === 'string') return stripReminders(m.content);
  if (!Array.isArray(m.content)) return '';
  return stripReminders(
    m.content
      .filter((b) => b && b.type === 'text' && typeof b.text === 'string')
      .map((b) => b.text)
      .join('\n')
  );
}

// Recent text turns before the newest user message, newest last, trimmed.
function recentHistory(messages, maxTurns = 8, maxChars = 4000) {
  if (!Array.isArray(messages)) return '';
  const turns = [];
  let skippedLatest = false;
  for (let i = messages.length - 1; i >= 0 && turns.length < maxTurns; i--) {
    const m = messages[i];
    const t = turnText(m);
    if (!t) continue;
    if (!skippedLatest && m.role === 'user') {
      skippedLatest = true;
      continue;
    }
    const clipped = t.length > 700 ? t.slice(0, 700) + ' [...]' : t;
    turns.unshift(`${m.role === 'user' ? 'User' : 'Assistant'}: ${clipped}`);
  }
  let out = turns.join('\n\n');
  if (out.length > maxChars) out = '[...]' + out.slice(out.length - maxChars);
  return out;
}

// Which Claude Code session each project's Freebuff session last served.
const servedSession = new Map();

async function buildPrompt(cwd, body, sessionId, text, homeDir) {
  const client = require('./fb-client');
  const running = !!(await client.status(cwd).catch(() => null));
  const fresh = !running || servedSession.get(cwd) !== sessionId;
  servedSession.set(cwd, sessionId);
  if (!fresh) return text;
  const history = recentHistory(body.messages);
  return (
    '[Context from Claude Code] You are the model behind Claude Code here: the user picked you with ' +
    '"/model freebuff" and is typing in Claude Code, which shows your reply as its answer. ' +
    (homeDir
      ? `Claude Code was started in the user's home folder (${homeDir}), so you are running in a scratch workspace (${cwd}); ` +
        `files the user mentions are usually under ${homeDir}, use absolute paths. `
      : `Project folder: ${cwd}. `) +
    `Slash commands such as /model are handled by Claude Code, not you, so ignore them. ` +
    'Work on the files directly when asked and keep replies short.' +
    (history ? `\n\nRecent conversation in Claude Code (for context):\n${history}` : '') +
    `\n\nThe user's message:\n${text}`
  );
}

function estimateTokens(body) {
  return Math.max(1, Math.ceil(JSON.stringify(body.messages || '').length / 4) + Math.ceil(systemText(body.system).length / 4));
}

// One Freebuff ask at a time per project.
const queues = new Map();
function serialize(cwd, fn) {
  const prev = queues.get(cwd) || Promise.resolve();
  const next = prev.catch(() => {}).then(fn);
  queues.set(cwd, next);
  return next;
}

function isHomeDir(cwd) {
  const norm = (p) => path.resolve(p).replace(/[\\/]+$/, '').toLowerCase();
  return norm(cwd) === norm(os.homedir());
}

// Freebuff will not open the home folder as a project (it shows a folder picker and
// Enter just navigates up), so Claude Code sessions started in ~ use a scratch workspace.
function homeWorkspace() {
  const dir = process.env.FB_GATEWAY_HOME_WORKSPACE || path.join(os.homedir(), '.claude', 'freebuff-home');
  const fs = require('fs');
  try {
    fs.mkdirSync(dir, { recursive: true });
    const agents = path.join(dir, 'AGENTS.md');
    if (!fs.existsSync(agents)) {
      fs.writeFileSync(
        agents,
        '# Freebuff home workspace\n\n' +
          `The user started Claude Code in their home folder (${os.homedir()}) and picked Freebuff as the model. ` +
          'This folder is a scratch workspace for general questions. Files the user mentions usually live under ' +
          `${os.homedir()}; use absolute paths. For real project work, suggest opening Claude Code in that project's folder.\n`
      );
    }
  } catch (e) {}
  return dir;
}

async function askFreebuff(cwd, text, onText) {
  const client = require('./fb-client');
  const chat = require('./fb-chat');
  const timeoutSec = Number(process.env.FB_ASK_TIMEOUT_SEC) || undefined;
  try {
    const res = await client.ask(cwd, text, {
      timeoutSec,
      onEvent: (ev) => {
        onText(chat.formatEvent(ev));
      },
    });
    if (res.ok) return;
    if (res.outcome === 'error') return onText(`\n[fb] ${res.final.message}\n`);
    const tail = (res.final.screen || []).slice(-25).join('\n');
    onText(
      `\n[fb] ${res.final.reason || res.outcome}\n` +
        (tail ? `Last screen:\n${tail}\n` : '') +
        'Run `! fb screen`, `! fb keys "\\r"` or `! fb new` to unstick it.\n'
    );
  } catch (e) {
    onText(`\n[fb] ${e && e.message ? e.message : e}\n`);
  }
}

function sse(res, event, data) {
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

async function handleFreebuff(req, res, body) {
  const claudeCwd = projectDir(body);
  const inHome = isHomeDir(claudeCwd);
  const cwd = inHome ? homeWorkspace() : claudeCwd;
  const userText = latestUserText(body.messages) || 'Continue.';
  const sessionId = req.headers['x-claude-code-session-id'] || 'default';
  const text = await serialize(cwd, () => buildPrompt(cwd, body, sessionId, userText, inHome ? claudeCwd : null));
  const model = body.model;
  const id = 'msg_fb_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  const inputTokens = estimateTokens(body);
  log(`freebuff ask (${cwd})${text !== userText ? ' +context' : ''}: ${userText.slice(0, 80).replace(/\s+/g, ' ')}`);

  if (!body.stream) {
    let out = '';
    await serialize(cwd, () => askFreebuff(cwd, text, (t) => (out += t)));
    out = out.trim() || '(Freebuff sent an empty reply)';
    res.writeHead(200, { 'content-type': 'application/json', 'request-id': id });
    res.end(
      JSON.stringify({
        id, type: 'message', role: 'assistant', model,
        content: [{ type: 'text', text: out }],
        stop_reason: 'end_turn', stop_sequence: null,
        usage: { input_tokens: inputTokens, output_tokens: Math.ceil(out.length / 4) },
      })
    );
    return;
  }

  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache',
    connection: 'keep-alive',
    'request-id': id,
  });
  sse(res, 'message_start', {
    type: 'message_start',
    message: {
      id, type: 'message', role: 'assistant', model, content: [],
      stop_reason: null, stop_sequence: null,
      usage: { input_tokens: inputTokens, output_tokens: 0 },
    },
  });
  sse(res, 'content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } });
  sse(res, 'ping', { type: 'ping' });
  const pinger = setInterval(() => sse(res, 'ping', { type: 'ping' }), PING_MS);
  let chars = 0;
  const onText = (t) => {
    if (!t) return;
    chars += t.length;
    sse(res, 'content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: t } });
  };
  try {
    await serialize(cwd, () => askFreebuff(cwd, text, onText));
    if (!chars) onText('(Freebuff sent an empty reply)');
  } finally {
    clearInterval(pinger);
  }
  sse(res, 'content_block_stop', { type: 'content_block_stop', index: 0 });
  sse(res, 'message_delta', {
    type: 'message_delta',
    delta: { stop_reason: 'end_turn', stop_sequence: null },
    usage: { output_tokens: Math.ceil(chars / 4) },
  });
  sse(res, 'message_stop', { type: 'message_stop' });
  res.end();
}

function passthrough(req, res, bodyBuf) {
  const headers = Object.assign({}, req.headers);
  delete headers.host;
  delete headers.connection;
  headers.host = UPSTREAM.host;
  if (bodyBuf) headers['content-length'] = String(bodyBuf.length);
  const basePath = UPSTREAM.pathname.replace(/\/$/, '');
  const lib = UPSTREAM.protocol === 'http:' ? http : https;
  const up = lib.request(
    {
      protocol: UPSTREAM.protocol,
      hostname: UPSTREAM.hostname,
      port: UPSTREAM.port || undefined,
      method: req.method,
      path: basePath + req.url,
      headers,
    },
    (upRes) => {
      res.writeHead(upRes.statusCode || 502, upRes.headers);
      upRes.pipe(res);
    }
  );
  up.on('error', (e) => {
    log(`upstream error: ${e.message}`);
    if (!res.headersSent) {
      res.writeHead(502, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ type: 'error', error: { type: 'api_error', message: `fb-gateway upstream: ${e.message}` } }));
    } else res.destroy();
  });
  req.on('aborted', () => up.destroy());
  if (bodyBuf) up.end(bodyBuf);
  else up.end();
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

async function onRequest(req, res) {
  const url = req.url || '/';
  if (req.method === 'GET' && url === '/__fb_gateway') {
    res.writeHead(200, { 'content-type': 'application/json' });
    return res.end(JSON.stringify({ ok: true, pid: process.pid, upstream: UPSTREAM.href }));
  }
  const isMessages = req.method === 'POST' && /^\/v1\/messages(\/count_tokens)?(\?|$)/.test(url);
  if (!isMessages) return passthrough(req, res, null);

  const buf = await readBody(req);
  let body = null;
  try {
    body = JSON.parse(buf.toString('utf8'));
  } catch (e) {
    return passthrough(req, res, buf);
  }
  if (!body || !isFreebuffModel(body.model)) return passthrough(req, res, buf);
  if (process.env.FB_GATEWAY_DUMP) {
    try {
      require('fs').writeFileSync(process.env.FB_GATEWAY_DUMP, JSON.stringify({ url, headers: Object.keys(req.headers), body }, null, 2));
    } catch (e) {}
  }

  if (/count_tokens/.test(url)) {
    res.writeHead(200, { 'content-type': 'application/json' });
    return res.end(JSON.stringify({ input_tokens: estimateTokens(body) }));
  }
  // Tool-less requests are Claude Code background work (titles, summaries): send to Haiku.
  if (!Array.isArray(body.tools) || body.tools.length === 0) {
    body.model = BG_MODEL;
    return passthrough(req, res, Buffer.from(JSON.stringify(body), 'utf8'));
  }
  return handleFreebuff(req, res, body);
}

function createServer() {
  return http.createServer((req, res) => {
    onRequest(req, res).catch((e) => {
      log(`request failed: ${e && e.stack ? e.stack : e}`);
      try {
        if (!res.headersSent) res.writeHead(500, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ type: 'error', error: { type: 'api_error', message: String(e && e.message) } }));
      } catch (_) {}
    });
  });
}

function run() {
  const server = createServer();
  server.on('error', (e) => {
    if (e.code === 'EADDRINUSE') {
      log(`port ${port()} already in use; another gateway is probably running`);
      process.exit(0);
    }
    log(`server error: ${e.message}`);
    process.exit(1);
  });
  server.listen(port(), '127.0.0.1', () => log(`listening on http://127.0.0.1:${port()} -> ${UPSTREAM.href}`));
  return server;
}

// Resolves true if a gateway answers on the port.
function ping(timeoutMs = 800) {
  return new Promise((resolve) => {
    const r = http.get({ host: '127.0.0.1', port: port(), path: '/__fb_gateway', timeout: timeoutMs }, (res) => {
      res.resume();
      resolve(res.statusCode === 200);
    });
    r.on('timeout', () => r.destroy());
    r.on('error', () => resolve(false));
  });
}

if (require.main === module) run();

module.exports = { run, ping, port, createServer, latestUserText, recentHistory, projectDir, isFreebuffModel, DEFAULT_PORT };
