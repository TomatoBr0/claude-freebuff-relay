#!/usr/bin/env node
'use strict';
// Freebuff mode through the real UserPromptSubmit hook, with the fake Freebuff in a PTY.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const HOOK = path.join(ROOT, 'scripts', 'hook.js');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'fbmode-'));
const proj = path.join(tmp, 'mode proj');
fs.mkdirSync(proj, { recursive: true });
const env = Object.assign({}, process.env, {
  CLAUDE_CONFIG_DIR: path.join(tmp, 'claude'),
  RELAY_FREEBUFF_HOME: path.join(tmp, 'manicode'),
  FB_AGENT_CMD: process.execPath,
  FB_AGENT_ARGS: JSON.stringify([path.join(__dirname, 'fake-freebuff.js')]),
  RELAY_NO_LAUNCH: '1',
  RELAY_AUTO_IMPORT: '0',
});

let passed = 0;
let failed = 0;
function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  ok   ${name}`);
  } catch (e) {
    failed++;
    console.log(`  FAIL ${name}\n       ${String(e && e.message).split('\n').slice(0, 6).join('\n       ')}`);
  }
}

function prompt(text) {
  const r = spawnSync(process.execPath, [HOOK, 'prompt'], {
    input: JSON.stringify({ hook_event_name: 'UserPromptSubmit', cwd: proj, session_id: 's1', prompt: text }),
    encoding: 'utf8',
    env,
    timeout: 120000,
  });
  assert.strictEqual(r.status, 0, r.stderr);
  return r.stdout.trim() ? JSON.parse(r.stdout) : null;
}

console.log('fb-model mode (hook)');
const mode = require('../lib/fb-mode');
test('parseToggle reads the command forms', () => {
  assert.strictEqual(mode.parseToggle('/fb-model on'), 'on');
  assert.strictEqual(mode.parseToggle('/freebuff-relay:fb-model off'), 'off');
  assert.strictEqual(mode.parseToggle('<command-name>/fb-model</command-name> <command-args>on</command-args>'), 'on');
  assert.strictEqual(mode.parseToggle('/fb-model'), 'status');
  assert.strictEqual(mode.parseToggle('please fb-model on'), null);
});

test('with mode off, prompts go to Claude (no block)', () => {
  const o = prompt('hello claude');
  assert.ok(!o || o.decision !== 'block', JSON.stringify(o));
});

test('/fb-model on turns it on and blocks with a status line', () => {
  const o = prompt('/fb-model on');
  assert.strictEqual(o.decision, 'block');
  assert.ok(/ON/.test(o.reason), o.reason);
});

test('with mode on, a prompt is answered by Freebuff instead of Claude', () => {
  const o = prompt('hello freebuff');
  assert.strictEqual(o.decision, 'block');
  assert.ok(o.reason.includes('hello freebuff') && o.reason.startsWith('Freebuff:'), o.reason);
  assert.ok(o.reason.includes('[Context from Claude Code]'), 'first message carries context');
  assert.ok(!/SECRET|THINKING|TOOL OUTPUT/.test(o.reason), o.reason);
});

test('second message in the same session is sent bare', () => {
  const o = prompt('second one');
  assert.ok(o.reason.includes('FAKE REPLY: second one'), o.reason);
});

test('/fb-model off returns to Claude', () => {
  assert.ok(/OFF/.test(prompt('/fb-model off').reason));
  const o = prompt('back to claude');
  assert.ok(!o || o.decision !== 'block', JSON.stringify(o));
});

spawnSync(process.execPath, [path.join(ROOT, 'bin', 'fb.js'), '--cwd', proj, 'stop'], { env, encoding: 'utf8', timeout: 30000 });
console.log(`\n${passed} passed, ${failed} failed`);
process.exitCode = failed ? 1 : 0;
