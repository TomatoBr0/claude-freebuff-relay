#!/usr/bin/env node
'use strict';
// Tests for lib/fb-gateway.js: Freebuff routing (fake Freebuff in a PTY) and byte-for-byte
// passthrough to a fake upstream. Run: node test/gateway.js

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');
const FAKE = path.join(__dirname, 'fake-freebuff.js');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'fbgw-'));
const proj = path.join(tmp, 'gw proj');
fs.mkdirSync(proj, { recursive: true });
const GW_PORT = 47000 + Math.floor(Math.random() * 900);

let passed = 0;
let failed = 0;
async function test(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`  ok   ${name}`);
  } catch (e) {
    failed++;
    console.log(`  FAIL ${name}\n       ${e && e.stack ? e.stack.split('\n').slice(0, 4).join('\n       ') : e}`);
  }
}

function post(p, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const data = Buffer.from(JSON.stringify(body));
    const r = http.request(
      { host: '127.0.0.1', port: GW_PORT, path: p, method: 'POST', headers: Object.assign({ 'content-type': 'application/json', 'content-length': data.length }, headers) },
      (res) => {
        let s = '';
        res.setEncoding('utf8');
        res.on('data', (c) => (s += c));
        res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: s }));
      }
    );
    r.on('error', reject);
    r.end(data);
  });
}

async function main() {
  // Fake Anthropic upstream: echoes what it received.
  const seen = [];
  const upstream = http.createServer((req, res) => {
    let s = '';
    req.on('data', (c) => (s += c));
    req.on('end', () => {
      seen.push({ url: req.url, headers: req.headers, body: s });
      res.writeHead(200, { 'content-type': 'application/json', 'x-upstream': 'yes' });
      res.end(JSON.stringify({ upstream: true, model: JSON.parse(s || '{}').model }));
    });
  });
  await new Promise((r) => upstream.listen(0, '127.0.0.1', r));
  const upPort = upstream.address().port;

  const env = Object.assign({}, process.env, {
    FB_GATEWAY_PORT: String(GW_PORT),
    FB_GATEWAY_UPSTREAM: `http://127.0.0.1:${upPort}`,
    FB_GATEWAY_QUIET: '1',
    RELAY_FREEBUFF_HOME: path.join(tmp, 'manicode'),
    FB_AGENT_CMD: process.execPath,
    FB_AGENT_ARGS: JSON.stringify([FAKE]),
  });
  const gwProc = spawn(process.execPath, [path.join(ROOT, 'lib', 'fb-gateway.js')], { env, stdio: 'inherit' });
  process.env.FB_GATEWAY_PORT = String(GW_PORT);
  const gw = require('../lib/fb-gateway');
  for (let i = 0; i < 50 && !(await gw.ping()); i++) await new Promise((r) => setTimeout(r, 100));

  const system = [{ type: 'text', text: `You are Claude Code.\n# Environment\n - Primary working directory: ${proj}\n` }];
  const tools = [{ name: 'Bash', description: 'x', input_schema: { type: 'object' } }];

  console.log('fb gateway');
  await test('helpers: latest user text strips system reminders', () => {
    const t = gw.latestUserText([
      { role: 'user', content: 'old' },
      { role: 'assistant', content: 'a' },
      { role: 'user', content: [{ type: 'text', text: '<system-reminder>noise</system-reminder>' }, { type: 'text', text: 'fix the bug' }] },
    ]);
    assert.strictEqual(t, 'fix the bug');
    assert.strictEqual(gw.projectDir({ system }), path.resolve(proj));
  });

  await test('non-freebuff model passes through with auth headers unchanged', async () => {
    const r = await post('/v1/messages?beta=true', { model: 'claude-opus-4-7', messages: [] }, { authorization: 'Bearer TOKEN', 'anthropic-beta': 'oauth-2025-04-20' });
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.headers['x-upstream'], 'yes');
    const last = seen[seen.length - 1];
    assert.strictEqual(last.url, '/v1/messages?beta=true');
    assert.strictEqual(last.headers.authorization, 'Bearer TOKEN');
    assert.strictEqual(last.headers['anthropic-beta'], 'oauth-2025-04-20');
  });

  await test('freebuff request without tools (background work) goes upstream as the bg model', async () => {
    const r = await post('/v1/messages', { model: 'freebuff', system, messages: [{ role: 'user', content: 'title this' }] });
    assert.strictEqual(r.status, 200);
    assert.notStrictEqual(JSON.parse(r.body).model, 'freebuff');
  });

  await test('freebuff count_tokens is answered locally', async () => {
    const n = seen.length;
    const r = await post('/v1/messages/count_tokens', { model: 'freebuff', system, messages: [{ role: 'user', content: 'hi' }], tools });
    assert.strictEqual(r.status, 200);
    assert.ok(JSON.parse(r.body).input_tokens > 0);
    assert.strictEqual(seen.length, n);
  });

  await test('freebuff streaming request returns a full SSE message with Freebuff reply', async () => {
    const r = await post('/v1/messages?beta=true', {
      model: 'freebuff', stream: true, system, tools, max_tokens: 1000,
      messages: [{ role: 'user', content: [{ type: 'text', text: 'hello gateway' }] }],
    });
    assert.strictEqual(r.status, 200);
    assert.ok(/text\/event-stream/.test(r.headers['content-type']));
    const events = r.body.split('\n').filter((l) => l.startsWith('event: ')).map((l) => l.slice(7));
    assert.deepStrictEqual(
      events.filter((e) => e !== 'ping' && e !== 'content_block_delta'),
      ['message_start', 'content_block_start', 'content_block_stop', 'message_delta', 'message_stop']
    );
    const text = r.body
      .split('\n')
      .filter((l) => l.startsWith('data: '))
      .map((l) => JSON.parse(l.slice(6)))
      .filter((d) => d.type === 'content_block_delta')
      .map((d) => d.delta.text)
      .join('');
    assert.ok(text.includes('hello gateway'), text);
    assert.ok(text.includes('[Context from Claude Code]'), 'first message carries context');
    assert.ok(!/SECRET|THINKING|TOOL OUTPUT/.test(text), text);
  });

  await test('freebuff non-streaming request returns a JSON message', async () => {
    const r = await post('/v1/messages', { model: 'freebuff', system, tools, messages: [{ role: 'user', content: 'second' }] });
    const m = JSON.parse(r.body);
    assert.strictEqual(m.role, 'assistant');
    assert.ok(m.content[0].text.includes('FAKE REPLY: second'), m.content[0].text);
    assert.ok(!m.content[0].text.includes('[Context from Claude Code]'), 'later messages are sent bare');
  });

  await test('freebuff in the home folder answers with a hint instead of hanging', async () => {
    const homeSys = [{ type: 'text', text: `Primary working directory: ${os.homedir()}` }];
    const r = await post('/v1/messages', { model: 'freebuff', system: homeSys, tools, messages: [{ role: 'user', content: 'hi' }] });
    assert.ok(/home folder/.test(JSON.parse(r.body).content[0].text), r.body);
  });

  await test('command echoes are stripped; history skips the newest user turn', () => {
    const msgs = [
      { role: 'user', content: 'first question' },
      { role: 'assistant', content: 'first answer' },
      { role: 'user', content: [{ type: 'text', text: '<command-name>/model</command-name>\n<command-message>model</command-message>\n<command-args></command-args>' }, { type: 'text', text: '<local-command-stdout>Set model</local-command-stdout>' }] },
      { role: 'user', content: 'hello?' },
    ];
    assert.strictEqual(gw.latestUserText(msgs), 'hello?');
    const h = gw.recentHistory(msgs);
    assert.ok(h.includes('User: first question') && h.includes('Assistant: first answer'), h);
    assert.ok(!/hello\?|\/model/.test(h), h);
  });

  await test('suggest_followups renders as a numbered list of next steps', () => {
    const out = require('../lib/fb-chat').formatEvent({
      type: 'tool', name: 'suggest_followups', arg: '',
      followups: [{ label: 'Run checks', prompt: 'Run the tests' }, { label: 'Review', prompt: '' }],
    });
    assert.ok(out.includes('Suggested next steps:'), out);
    assert.ok(out.includes('1. Run checks — Run the tests') && out.includes('2. Review'), out);
    assert.ok(!out.includes('→'), out);
  });

  await test('working directory is found in the first user message too', () => {
    const d = gw.projectDir({ system: 'x', messages: [{ role: 'user', content: [{ type: 'text', text: `<system-reminder>
 - Primary working directory: ${proj}
</system-reminder>` }] }] });
    assert.strictEqual(d, path.resolve(proj));
  });

  // Cleanup: stop the fake Freebuff daemon, the gateway and the upstream.
  try {
    process.env.RELAY_FREEBUFF_HOME = env.RELAY_FREEBUFF_HOME;
    await require('../lib/fb-client').stop(path.resolve(proj));
  } catch (e) {}
  gwProc.kill();
  upstream.close();
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exitCode = failed ? 1 : 0;
  setTimeout(() => process.exit(process.exitCode), 300);
}

main();
