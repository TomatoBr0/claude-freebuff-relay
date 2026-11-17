#!/usr/bin/env node
'use strict';
// Minimal MCP server over stdio (newline-delimited JSON-RPC 2.0). No dependencies.
// Tools: freebuff_ask (send work to Freebuff and return its reply), freebuff_screen.
// Logs go to stderr only; stdout carries protocol frames.

const path = require('path');
const client = require('./fb-client');
const chat = require('./fb-chat');
const proto = require('./fb-protocol');

const PKG = require(path.join(__dirname, '..', 'package.json'));
const DEFAULT_PROTOCOL = '2024-11-05';

const CWD_PROP = {
  type: 'string',
  description: 'Project folder. Default: the project directory of this Claude session.',
};

const TOOLS = [
  {
    name: 'freebuff_ask',
    description:
      'Send a self-contained task or question to Freebuff (a free coding agent) running in a background session for this project, and return its reply. ' +
      'Use it to hand cheap, well-specified work to Freebuff to save Claude tokens. Freebuff reads the project files itself. ' +
      'Blocks until Freebuff finishes, which can take minutes.',
    inputSchema: {
      type: 'object',
      properties: {
        message: { type: 'string', description: 'What Freebuff should do or answer.' },
        cwd: CWD_PROP,
      },
      required: ['message'],
    },
  },
  {
    name: 'freebuff_screen',
    description:
      'Show the last lines of the Freebuff terminal screen for this project. Use it when Freebuff seems stuck (login, rejoin or ad screen).',
    inputSchema: {
      type: 'object',
      properties: {
        cwd: CWD_PROP,
        lines: { type: 'number', description: 'How many lines (default 40).' },
      },
    },
  },
];

function send(obj) {
  process.stdout.write(JSON.stringify(obj) + '\n');
}

function reply(id, result) {
  send({ jsonrpc: '2.0', id, result });
}

function fail(id, code, message) {
  send({ jsonrpc: '2.0', id, error: { code, message } });
}

function textResult(text, isError) {
  return { content: [{ type: 'text', text }], isError: !!isError };
}

function resolveCwd(args) {
  const raw = args && typeof args.cwd === 'string' && args.cwd ? args.cwd : process.env.CLAUDE_PROJECT_DIR || process.cwd();
  return path.resolve(proto.toNativePath(raw));
}

async function callAsk(args) {
  if (!args || typeof args.message !== 'string' || !args.message.trim()) {
    return textResult('freebuff_ask needs a non-empty "message".', true);
  }
  const cwd = resolveCwd(args);
  const timeoutSec = Number(process.env.FB_ASK_TIMEOUT_SEC) || undefined;
  let out = '';
  try {
    const res = await client.ask(cwd, args.message.trim(), {
      timeoutSec,
      onEvent: (ev) => {
        out += chat.formatEvent(ev);
      },
    });
    if (res.ok) return textResult(out.trim() || '(Freebuff sent an empty reply)', false);
    if (res.outcome === 'error') return textResult(res.final.message, true);
    const tail = (res.final.screen || []).slice(-25).join('\n');
    return textResult(
      `${out}[fb] ${res.final.reason || res.outcome}\n` +
        (tail ? `Last screen:\n${tail}\n` : '') +
        'Use freebuff_screen to look at the screen, or ask Claude to run "fb keys" / "fb new".',
      true
    );
  } catch (e) {
    return textResult(e.message, true);
  }
}

async function callScreen(args) {
  const cwd = resolveCwd(args);
  try {
    const lines = await client.screen(cwd, Number(args && args.lines) > 0 ? Number(args.lines) : 40);
    return textResult(lines.join('\n') || '(screen is empty)', false);
  } catch (e) {
    return textResult(e.message, true);
  }
}

async function callTool(id, params) {
  const name = params.name;
  const args = params.arguments || {};
  let result;
  if (name === 'freebuff_ask') result = await callAsk(args);
  else if (name === 'freebuff_screen') result = await callScreen(args);
  else {
    fail(id, -32602, `Unknown tool: ${name}`);
    return;
  }
  reply(id, result);
}

async function handle(msg) {
  const { id, method, params } = msg;
  const isNotification = id === undefined || id === null;
  switch (method) {
    case 'initialize':
      return reply(id, {
        protocolVersion: (params && params.protocolVersion) || DEFAULT_PROTOCOL,
        capabilities: { tools: {} },
        serverInfo: { name: 'freebuff', version: PKG.version },
      });
    case 'ping':
      return isNotification ? undefined : reply(id, {});
    case 'tools/list':
      return reply(id, { tools: TOOLS });
    case 'tools/call':
      return callTool(id, params || {});
    default:
      if (!isNotification) fail(id, -32601, `Method not found: ${method}`);
  }
}

function main() {
  const feed = proto.lineSplitter((line) => {
    let msg;
    try {
      msg = JSON.parse(line);
    } catch (e) {
      fail(null, -32700, 'Parse error');
      return;
    }
    if (!msg || typeof msg !== 'object') return;
    handle(msg).catch((e) => {
      if (msg.id !== undefined && msg.id !== null) fail(msg.id, -32603, e && e.message ? e.message : String(e));
    });
  });
  process.stdin.on('data', feed);
  process.stdin.on('error', () => {});
}

if (require.main === module) {
  main();
}

module.exports = { TOOLS, handle };
