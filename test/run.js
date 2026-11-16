'use strict';
// Self-contained tests (no framework). Run: node test/run.js

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const core = require(path.join(ROOT, 'lib', 'core.js'));
const HOOK = path.join(ROOT, 'scripts', 'hook.js');

let passed = 0;
let failed = 0;
const failures = [];

function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  ok   ${name}`);
  } catch (err) {
    failed++;
    failures.push({ name, err });
    console.log(`  FAIL ${name}\n       ${err && err.message ? err.message.split('\n')[0] : err}`);
  }
}

function runHook(event, input, env, cwd) {
  const r = spawnSync(process.execPath, [HOOK, event], {
    input: typeof input === 'string' ? input : JSON.stringify(input),
    cwd,
    encoding: 'utf8',
    env: Object.assign({}, process.env, { RELAY_NO_LAUNCH: '1' }, env || {}),
    timeout: 30000,
  });
  return r;
}

// Use a dedicated temp area so nothing leaks into the repo or the real Freebuff config.
const TEST_BASE = path.join(os.tmpdir(), 'claude', 'relay-test');
fs.mkdirSync(TEST_BASE, { recursive: true });
const tmpRoot = fs.mkdtempSync(path.join(TEST_BASE, 'run-'));
const projDir = path.join(tmpRoot, 'my proj');
const fbHome = path.join(tmpRoot, 'manicode');
fs.mkdirSync(projDir, { recursive: true });
fs.mkdirSync(fbHome, { recursive: true });

console.log('parseResetTime');

test('"resets 3pm" before 3pm gives today 15:00', () => {
  const now = new Date(2026, 10, 16, 10, 0, 0);
  const got = core.parseResetTime('You\'ve hit your limit · resets 3pm', now);
  assert.strictEqual(got, new Date(2026, 10, 16, 15, 0, 0).toISOString());
});

test('"resets 3pm" after 3pm gives tomorrow 15:00', () => {
  const now = new Date(2026, 10, 16, 16, 0, 0);
  const got = core.parseResetTime('resets 3pm', now);
  assert.strictEqual(got, new Date(2026, 10, 17, 15, 0, 0).toISOString());
});

test('"resets at 3:30 PM" gives 15:30', () => {
  const now = new Date(2026, 10, 16, 10, 0, 0);
  const got = core.parseResetTime('limit reached, resets at 3:30 PM', now);
  assert.strictEqual(got, new Date(2026, 10, 16, 15, 30, 0).toISOString());
});

test('"resets 11am (America/Los_Angeles)" ignores the timezone', () => {
  const now = new Date(2026, 10, 16, 8, 0, 0);
  const got = core.parseResetTime('resets 11am (America/Los_Angeles)', now);
  assert.strictEqual(got, new Date(2026, 10, 16, 11, 0, 0).toISOString());
});

test('"resets Nov 18, 2pm" gives that date this year', () => {
  const now = new Date(2026, 10, 16, 10, 0, 0);
  const got = core.parseResetTime('resets Nov 18, 2pm', now);
  assert.strictEqual(got, new Date(2026, 10, 18, 14, 0, 0).toISOString());
});

test('past "Mon DD, time" rolls to next year', () => {
  const now = new Date(2026, 10, 16, 10, 0, 0);
  const got = core.parseResetTime('resets Nov 1, 2pm', now);
  assert.strictEqual(got, new Date(2027, 10, 1, 14, 0, 0).toISOString());
});

test('"no time here" gives null', () => {
  assert.strictEqual(core.parseResetTime('no time here', new Date()), null);
  assert.strictEqual(core.parseResetTime('', new Date()), null);
  assert.strictEqual(core.parseResetTime(null, new Date()), null);
});

console.log('buildHandoff');

test('handoff keeps the task, files, todos and skips meta/tool_result noise', () => {
  const t = path.join(tmpRoot, 'transcript-unit.jsonl');
  fs.writeFileSync(
    t,
    [
      JSON.stringify({ type: 'user', isMeta: true, message: { role: 'user', content: 'META NOISE' } }),
      JSON.stringify({ type: 'user', message: { role: 'user', content: 'Unit task text' } }),
      JSON.stringify({
        type: 'assistant',
        message: {
          role: 'assistant',
          content: [
            { type: 'thinking', thinking: 'SECRET THOUGHT' },
            { type: 'tool_use', name: 'Edit', input: { file_path: 'src/unit.js', old_string: 'a', new_string: 'b' } },
          ],
        },
      }),
      JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', content: 'RESULT TEXT' }] } }),
    ].join('\n')
  );
  const md = core.buildHandoff(tmpRoot, t, new Date());
  assert.ok(md.includes('Unit task text'));
  assert.ok(md.includes('src/unit.js'));
  assert.ok(!md.includes('META NOISE'));
  assert.ok(!md.includes('SECRET THOUGHT'));
  assert.ok(!md.includes('RESULT TEXT'));
});

console.log('freebuff chat rendering');

test('thinking text and tool output are excluded, normal text and tool lines kept', () => {
  const lines = core.renderFreebuffChat([
    { id: 'u1', variant: 'user', content: 'Hello freebuff', timestamp: 1 },
    {
      id: 'a1',
      variant: 'ai',
      content: '',
      blocks: [
        { type: 'text', content: 'THINKING ONE', thinkingId: 't1' },
        { type: 'text', content: 'THINKING TWO', textType: 'reasoning' },
        { type: 'tool', toolName: 'Edit', input: { path: 'src/x.js' }, output: 'TOOL OUTPUT SECRET' },
        { type: 'text', content: 'Normal reply here' },
        { type: 'mode-divider' },
        { type: 'mystery' },
      ],
    },
  ]);
  const joined = lines.join('\n');
  assert.ok(joined.includes('Hello freebuff'));
  assert.ok(joined.includes('Normal reply here'));
  assert.ok(joined.includes('→ Edit src/x.js'));
  assert.ok(!joined.includes('THINKING'));
  assert.ok(!joined.includes('TOOL OUTPUT SECRET'));
});

console.log('hook flow');

const transcriptPath = path.join(tmpRoot, 'claude-transcript.jsonl');
fs.writeFileSync(
  transcriptPath,
  [
    JSON.stringify({ type: 'user', message: { role: 'user', content: 'Add a dark mode toggle to settings' } }),
    JSON.stringify({
      type: 'assistant',
      message: {
        role: 'assistant',
        content: [
          { type: 'text', text: "I'll start by editing the settings file." },
          { type: 'tool_use', name: 'Edit', input: { file_path: 'src/settings.js', old_string: 'a', new_string: 'b' } },
          {
            type: 'tool_use',
            name: 'TodoWrite',
            input: {
              todos: [
                { content: 'Add toggle', status: 'in_progress' },
                { content: 'Write tests', status: 'pending' },
              ],
            },
          },
        ],
      },
    }),
    JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'x', content: 'ok' }] } }),
  ].join('\n')
);

test('limit hook writes HANDOFF.md and switches to freebuff mode', () => {
  const r = runHook(
    'limit',
    {
      cwd: projDir,
      transcript_path: transcriptPath,
      session_id: 'sess-1',
      error: 'rate_limit',
      last_assistant_message: "You've hit your limit · resets 3pm",
    },
    { RELAY_FREEBUFF_HOME: fbHome }
  );
  assert.strictEqual(r.status, 0, r.stderr);
  const handoff = fs.readFileSync(path.join(projDir, '.claude-relay', 'HANDOFF.md'), 'utf8');
  assert.ok(handoff.includes('You are Freebuff taking over from Claude Code'));
  assert.ok(handoff.includes('Add a dark mode toggle to settings'), 'original task');
  assert.ok(handoff.includes('src/settings.js'), 'file path');
  assert.ok(handoff.includes('- [ ] Add toggle'), 'todo');
  const state = JSON.parse(fs.readFileSync(path.join(projDir, '.claude-relay', 'state.json'), 'utf8'));
  assert.strictEqual(state.mode, 'freebuff');
  assert.ok(state.resetAt, 'resetAt parsed');
  const gi = fs.readFileSync(path.join(projDir, '.claude-relay', '.gitignore'), 'utf8');
  assert.strictEqual(gi.trim(), '*');
});

test('prompt hook injects freebuff chat, excludes thinking/tool output, switches back', () => {
  const chatDir = path.join(fbHome, 'projects', path.basename(projDir), 'chats', '2099-01-01T00-00-00.000Z');
  fs.mkdirSync(chatDir, { recursive: true });
  fs.writeFileSync(
    path.join(chatDir, 'chat-messages.json'),
    JSON.stringify([
      { id: 'u1', variant: 'user', content: 'Please also add a README section', timestamp: 1 },
      {
        id: 'a1',
        variant: 'ai',
        content: '',
        timestamp: 2,
        blocks: [
          { type: 'text', content: 'SECRET THINKING TEXT', thinkingId: 'th1' },
          { type: 'tool', toolName: 'Edit', input: { path: 'src/settings.js' }, output: 'TOOL OUTPUT SECRET' },
          { type: 'text', content: 'Normal reply: added the README section.' },
          { type: 'mode-divider' },
        ],
      },
    ])
  );
  const r = runHook('prompt', { cwd: projDir, session_id: 'sess-1', hook_event_name: 'UserPromptSubmit' }, { RELAY_FREEBUFF_HOME: fbHome });
  assert.strictEqual(r.status, 0, r.stderr);
  const out = JSON.parse(r.stdout);
  assert.strictEqual(out.hookSpecificOutput.hookEventName, 'UserPromptSubmit');
  const ctx = out.hookSpecificOutput.additionalContext;
  assert.ok(ctx.includes('Please also add a README section'), 'user msg');
  assert.ok(ctx.includes('Normal reply: added the README section.'), 'normal text');
  assert.ok(!ctx.includes('SECRET THINKING TEXT'), 'thinking excluded');
  assert.ok(!ctx.includes('TOOL OUTPUT SECRET'), 'tool output excluded');
  assert.ok(ctx.includes('→ Edit src/settings.js'), 'tool line');
  const log = fs.readFileSync(path.join(projDir, '.claude-relay', 'FREEBUFF_LOG.md'), 'utf8');
  assert.ok(log.includes('Normal reply'));
  const state = JSON.parse(fs.readFileSync(path.join(projDir, '.claude-relay', 'state.json'), 'utf8'));
  assert.strictEqual(state.mode, 'claude');
  assert.ok(state.lastSyncedAt);
});

test('second prompt produces empty stdout', () => {
  const r = runHook('prompt', { cwd: projDir }, { RELAY_FREEBUFF_HOME: fbHome });
  assert.strictEqual(r.status, 0, r.stderr);
  assert.strictEqual(r.stdout, '');
});

test('stop hook with a limit message in last_assistant_message triggers handoff', () => {
  const stopProj = path.join(tmpRoot, 'stop proj');
  fs.mkdirSync(stopProj, { recursive: true });
  const r = runHook(
    'stop',
    { cwd: stopProj, session_id: 's2', transcript_path: transcriptPath, last_assistant_message: 'Usage limit reached. Resets 5pm.' },
    { RELAY_FREEBUFF_HOME: fbHome }
  );
  assert.strictEqual(r.status, 0, r.stderr);
  const state = JSON.parse(fs.readFileSync(path.join(stopProj, '.claude-relay', 'state.json'), 'utf8'));
  assert.strictEqual(state.mode, 'freebuff');
  assert.ok(state.resetAt);
});

test('stop hook without limit text leaves mode as claude', () => {
  const plain = path.join(tmpRoot, 'plain proj');
  fs.mkdirSync(plain, { recursive: true });
  const r = runHook('stop', { cwd: plain, session_id: 's3', last_assistant_message: 'All done.' }, {});
  assert.strictEqual(r.status, 0, r.stderr);
  const state = JSON.parse(fs.readFileSync(path.join(plain, '.claude-relay', 'state.json'), 'utf8'));
  assert.strictEqual(state.mode, 'claude');
  assert.ok(!fs.existsSync(path.join(plain, '.claude-relay', 'HANDOFF.md')));
});

test('garbage stdin exits 0 for every event', () => {
  const garbageCwd = path.join(tmpRoot, 'garbage');
  fs.mkdirSync(garbageCwd, { recursive: true });
  for (const ev of ['limit', 'stop', 'session-start', 'prompt', 'nonsense']) {
    const r = runHook(ev, '{{{ not json', { RELAY_FREEBUFF_HOME: fbHome }, garbageCwd);
    assert.strictEqual(r.status, 0, `${ev}: ${r.stderr}`);
  }
});

test('CLI help prints usage', () => {
  const r = spawnSync(process.execPath, [path.join(ROOT, 'bin', 'claude-relay.js'), 'help'], { encoding: 'utf8' });
  assert.strictEqual(r.status, 0, r.stderr);
  assert.ok(r.stdout.includes('claude-relay'));
});

// Cleanup
try {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
} catch (e) {
  console.log(`  (could not remove ${tmpRoot}: ${e.message})`);
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) {
  process.exitCode = 1;
}
