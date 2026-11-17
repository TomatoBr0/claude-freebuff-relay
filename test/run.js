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
const BIN = path.join(ROOT, 'bin', 'claude-relay.js');
// In-process tests read these at call time; keep the developer's shell settings from leaking in.
process.env.RELAY_FREEBUFF_HOME = fbHome;
delete process.env.RELAY_AUTO_IMPORT;
delete process.env.RELAY_FIRST_LOOKBACK_HOURS;
delete process.env.RELAY_FREEBUFF_CONTEXT;
delete process.env.RELAY_HOME_OVERRIDE;

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

console.log('project matching');

test('projectRoot decides membership: same basename under another root is excluded', () => {
  const rootA = path.join(tmpRoot, 'rootA', 'shared');
  const rootB = path.join(tmpRoot, 'rootB', 'shared');
  const chatsDir = path.join(fbHome, 'projects', 'shared', 'chats');
  const mk = (name, runState) => {
    const d = path.join(chatsDir, name);
    fs.mkdirSync(d, { recursive: true });
    fs.writeFileSync(path.join(d, 'chat-messages.json'), JSON.stringify([]));
    if (runState !== undefined) fs.writeFileSync(path.join(d, 'run-state.json'), runState);
  };
  mk('2099-02-01T00-00-00.000Z', JSON.stringify({ sessionState: { fileContext: { projectRoot: rootA, cwd: rootA } } }));
  mk('2099-02-02T00-00-00.000Z', JSON.stringify({ sessionState: { fileContext: { cwd: rootA } } }));
  mk('2099-02-03T00-00-00.000Z', undefined);
  mk('2099-02-04T00-00-00.000Z', 'not json {{{');
  const names = (cwd) => core.findProjectChats(cwd).map((c) => c.name).sort();
  assert.deepStrictEqual(names(rootA), [
    '2099-02-01T00-00-00.000Z',
    '2099-02-02T00-00-00.000Z',
    '2099-02-03T00-00-00.000Z',
    '2099-02-04T00-00-00.000Z',
  ]);
  assert.deepStrictEqual(names(rootB), ['2099-02-03T00-00-00.000Z', '2099-02-04T00-00-00.000Z']);
});

console.log('auto-import (mode claude)');

const autoProj = path.join(tmpRoot, 'auto proj');
fs.mkdirSync(autoProj, { recursive: true });
const autoChat = path.join(fbHome, 'projects', 'auto proj', 'chats', '2099-03-01T00-00-00.000Z');
fs.mkdirSync(autoChat, { recursive: true });
const autoFile = path.join(autoChat, 'chat-messages.json');
const t0 = Date.now();
let autoMsgs = [
  { id: `user-${t0 - 60000}`, variant: 'user', content: 'AUTO FIRST USER MSG', timestamp: '03:00 PM' },
  { id: `ai-${t0 - 59000}-abc123`, variant: 'ai', content: '', blocks: [{ type: 'text', content: 'AUTO FIRST AI REPLY' }], timestamp: '03:00 PM' },
];
fs.writeFileSync(autoFile, JSON.stringify(autoMsgs));

test('first prompt in a claude-mode project imports recent Freebuff chat', () => {
  const r = runHook('prompt', { cwd: autoProj }, { RELAY_FREEBUFF_HOME: fbHome });
  assert.strictEqual(r.status, 0, r.stderr);
  const out = JSON.parse(r.stdout);
  assert.strictEqual(out.hookSpecificOutput.hookEventName, 'UserPromptSubmit');
  const ctx = out.hookSpecificOutput.additionalContext;
  assert.ok(ctx.includes('Since your last session here'), 'intro text');
  assert.ok(ctx.includes('AUTO FIRST USER MSG'));
  assert.ok(ctx.includes('AUTO FIRST AI REPLY'));
  const state = JSON.parse(fs.readFileSync(path.join(autoProj, '.claude-relay', 'state.json'), 'utf8'));
  assert.strictEqual(state.mode, 'claude');
  assert.ok(state.lastSyncedAt);
  assert.ok(state.importedChats['2099-03-01T00-00-00.000Z'] >= t0 - 59000);
});

test('second prompt with nothing new produces empty stdout', () => {
  const r = runHook('prompt', { cwd: autoProj }, { RELAY_FREEBUFF_HOME: fbHome });
  assert.strictEqual(r.status, 0, r.stderr);
  assert.strictEqual(r.stdout, '');
});

test('appending a newer message re-imports only that message', () => {
  const t1 = Date.now();
  autoMsgs = autoMsgs.concat([{ id: `user-${t1}`, variant: 'user', content: 'AUTO NEW MSG', timestamp: '03:05 PM' }]);
  fs.writeFileSync(autoFile, JSON.stringify(autoMsgs));
  const r = runHook('session-start', { cwd: autoProj, hook_event_name: 'SessionStart' }, { RELAY_FREEBUFF_HOME: fbHome });
  assert.strictEqual(r.status, 0, r.stderr);
  const out = JSON.parse(r.stdout);
  assert.strictEqual(out.hookSpecificOutput.hookEventName, 'SessionStart');
  const ctx = out.hookSpecificOutput.additionalContext;
  assert.ok(ctx.includes('AUTO NEW MSG'), 'new message');
  assert.ok(!ctx.includes('AUTO FIRST USER MSG'), 'old message not repeated');
  assert.ok(!ctx.includes('AUTO FIRST AI REPLY'), 'old reply not repeated');
});

test('RELAY_AUTO_IMPORT=0 disables auto-import in claude mode', () => {
  const offProj = path.join(tmpRoot, 'off proj');
  fs.mkdirSync(offProj, { recursive: true });
  const offChat = path.join(fbHome, 'projects', 'off proj', 'chats', '2099-03-02T00-00-00.000Z');
  fs.mkdirSync(offChat, { recursive: true });
  fs.writeFileSync(path.join(offChat, 'chat-messages.json'), JSON.stringify([{ id: `user-${Date.now()}`, variant: 'user', content: 'OFF MSG' }]));
  const r = runHook('prompt', { cwd: offProj }, { RELAY_FREEBUFF_HOME: fbHome, RELAY_AUTO_IMPORT: '0' });
  assert.strictEqual(r.status, 0, r.stderr);
  assert.strictEqual(r.stdout, '');
  assert.ok(!fs.existsSync(path.join(offProj, '.claude-relay')), 'no state written');
});

console.log('import CLI');

test('import --list is read-only and shows count and first prompt', () => {
  const listProj = path.join(tmpRoot, 'list proj');
  fs.mkdirSync(listProj, { recursive: true });
  const listChat = path.join(fbHome, 'projects', 'list proj', 'chats', '2099-04-01T00-00-00.000Z');
  fs.mkdirSync(listChat, { recursive: true });
  fs.writeFileSync(
    path.join(listChat, 'chat-messages.json'),
    JSON.stringify([{ id: `user-${Date.now()}`, variant: 'user', content: 'LIST MSG BODY' }])
  );
  fs.writeFileSync(path.join(listChat, 'chat-meta.json'), JSON.stringify({ messageCount: 2, firstPrompt: 'LIST FIRST PROMPT' }));
  const env = Object.assign({}, process.env, { RELAY_FREEBUFF_HOME: fbHome });
  const r = spawnSync(process.execPath, [BIN, 'import', '--list', '--cwd', listProj], { encoding: 'utf8', env });
  assert.strictEqual(r.status, 0, r.stderr);
  assert.ok(r.stdout.includes('2099-04-01T00-00-00.000Z'), r.stdout);
  assert.ok(r.stdout.includes('2 msgs'), r.stdout);
  assert.ok(r.stdout.includes('LIST FIRST PROMPT'), r.stdout);
  assert.ok(!fs.existsSync(path.join(listProj, '.claude-relay')), '--list must not write state');
});

test('import with no flags prints the newest chat in full and records it', () => {
  const listProj = path.join(tmpRoot, 'list proj');
  const env = Object.assign({}, process.env, { RELAY_FREEBUFF_HOME: fbHome });
  const r = spawnSync(process.execPath, [BIN, 'import', '--cwd', listProj], { encoding: 'utf8', env });
  assert.strictEqual(r.status, 0, r.stderr);
  assert.ok(r.stdout.includes('LIST MSG BODY'), r.stdout);
  const state = JSON.parse(fs.readFileSync(path.join(listProj, '.claude-relay', 'state.json'), 'utf8'));
  assert.ok(state.importedChats['2099-04-01T00-00-00.000Z']);
  assert.ok(state.lastSyncedAt);
});

console.log('freebuff context (AGENTS.md pointer + CLAUDE_CONTEXT.md)');

const BLOCK_START_TXT = '<!-- claude-relay:start -->';
const ctxRoot = path.join(tmpRoot, 'ctx');
fs.mkdirSync(ctxRoot, { recursive: true });
const mkDir = (name) => {
  const d = path.join(ctxRoot, name);
  fs.mkdirSync(d, { recursive: true });
  return d;
};
const ctxTranscript = path.join(ctxRoot, 'ctx-transcript.jsonl');
fs.writeFileSync(
  ctxTranscript,
  [
    JSON.stringify({ type: 'user', message: { role: 'user', content: 'Refactor the parser' } }),
    JSON.stringify({
      type: 'assistant',
      message: {
        role: 'assistant',
        content: [
          { type: 'text', text: 'Working on the parser now.' },
          { type: 'tool_use', name: 'Edit', input: { file_path: 'src/parser.js', old_string: 'a', new_string: 'b' } },
          {
            type: 'tool_use',
            name: 'TodoWrite',
            input: { todos: [{ content: 'Write parser tests', status: 'pending' }] },
          },
        ],
      },
    }),
  ].join('\n')
);

test('generated AGENTS.md mirrors CLAUDE.md and is git-excluded in a git repo', () => {
  const repo = mkDir('gen repo');
  const g = spawnSync('git', ['init', '-q'], { cwd: repo });
  assert.strictEqual(g.status, 0, 'git init failed');
  fs.writeFileSync(path.join(repo, 'CLAUDE.md'), '# Project rules\n\nUse tabs.\n');
  const r = runHook('stop', { cwd: repo, session_id: 'g1' }, {});
  assert.strictEqual(r.status, 0, r.stderr);
  const agents = fs.readFileSync(path.join(repo, 'AGENTS.md'), 'utf8');
  assert.strictEqual(agents.split(/\r?\n/)[0], core.GEN_MARK);
  assert.ok(agents.includes('Project instructions (mirrored from CLAUDE.md):'));
  assert.ok(agents.includes('# Project rules') && agents.includes('Use tabs.'));
  assert.strictEqual(agents.split(BLOCK_START_TXT).length - 1, 1);
  const ex = fs.readFileSync(path.join(repo, '.git', 'info', 'exclude'), 'utf8').split(/\r?\n/);
  assert.ok(ex.includes('/AGENTS.md'), 'AGENTS.md excluded');
  assert.ok(ex.includes('/.claude-relay/'), '.claude-relay excluded');
  const st = spawnSync('git', ['status', '--short'], { cwd: repo, encoding: 'utf8' }).stdout;
  assert.ok(!st.includes('AGENTS.md'), st);
  const rep = core.statusReport(repo);
  assert.ok(rep.includes('installed in AGENTS.md'), rep);
  // Second in-process run takes the fast path and reports no change.
  const again = core.ensureFreebuffPointer(repo);
  assert.strictEqual(again.changed, false);
});

test('user AGENTS.md gets the marker block exactly once; rest untouched; never overwritten', () => {
  const d = mkDir('user agents');
  const original = '# My agent notes\n\nKeep tests green.\n';
  fs.writeFileSync(path.join(d, 'AGENTS.md'), original);
  fs.writeFileSync(path.join(d, 'CLAUDE.md'), 'SHOULD NOT APPEAR\n');
  assert.strictEqual(runHook('stop', { cwd: d }, {}).status, 0);
  assert.strictEqual(runHook('stop', { cwd: d }, {}).status, 0);
  const after = fs.readFileSync(path.join(d, 'AGENTS.md'), 'utf8');
  assert.strictEqual(after, original + '\n' + core.POINTER_BLOCK + '\n');
  assert.strictEqual(after.split(BLOCK_START_TXT).length - 1, 1);
  assert.ok(!after.includes(core.GEN_MARK));
  assert.ok(!after.includes('SHOULD NOT APPEAR'));
});

test('RELAY_FREEBUFF_CONTEXT=0 writes no AGENTS.md and no CLAUDE_CONTEXT.md', () => {
  const d = mkDir('disabled');
  fs.writeFileSync(path.join(d, 'CLAUDE.md'), 'x\n');
  const r = runHook('stop', { cwd: d, session_id: 'x', transcript_path: ctxTranscript }, { RELAY_FREEBUFF_CONTEXT: '0' });
  assert.strictEqual(r.status, 0, r.stderr);
  assert.ok(!fs.existsSync(path.join(d, 'AGENTS.md')), 'no AGENTS.md');
  assert.ok(!fs.existsSync(path.join(d, '.claude-relay', 'CLAUDE_CONTEXT.md')), 'no context file');
});

test('home directory: no AGENTS.md pointer, but context + state still work (RELAY_HOME_OVERRIDE)', () => {
  const d = mkDir('fakehome');
  const r = runHook('stop', { cwd: d, transcript_path: ctxTranscript }, { RELAY_HOME_OVERRIDE: d });
  assert.strictEqual(r.status, 0, r.stderr);
  assert.ok(!fs.existsSync(path.join(d, 'AGENTS.md')), 'no AGENTS.md in home');
  assert.ok(fs.existsSync(path.join(d, '.claude-relay', 'CLAUDE_CONTEXT.md')), 'context still written in home');
  const p = runHook('prompt', { cwd: d }, { RELAY_HOME_OVERRIDE: d });
  assert.strictEqual(p.status, 0, p.stderr);
});

test('stop writes CLAUDE_CONTEXT.md with task, files, todos and recent turns', () => {
  const d = mkDir('ctx basic');
  const r = runHook('stop', { cwd: d, session_id: 'sess-ctx', transcript_path: ctxTranscript }, {});
  assert.strictEqual(r.status, 0, r.stderr);
  const c = fs.readFileSync(path.join(d, '.claude-relay', 'CLAUDE_CONTEXT.md'), 'utf8');
  assert.ok(c.includes('Latest Claude Code context for this project (auto-updated'));
  assert.ok(c.includes('session sess-ctx'));
  assert.ok(c.includes('Refactor the parser'));
  assert.ok(c.includes('src/parser.js'));
  assert.ok(c.includes('- [ ] Write parser tests'));
  assert.ok(c.includes('Working on the parser now.'));
  const state = JSON.parse(fs.readFileSync(path.join(d, '.claude-relay', 'state.json'), 'utf8'));
  assert.strictEqual(state.contextFrom.path, ctxTranscript);
  assert.strictEqual(state.mode, 'claude');
});

test('stop skips context regeneration when the transcript is unchanged', () => {
  const d = mkDir('ctx skip');
  assert.strictEqual(runHook('stop', { cwd: d, transcript_path: ctxTranscript }, {}).status, 0);
  const s1 = core.readState(d);
  assert.strictEqual(runHook('stop', { cwd: d, transcript_path: ctxTranscript }, {}).status, 0);
  const s2 = core.readState(d);
  assert.strictEqual(s2.contextUpdatedAt, s1.contextUpdatedAt, 'not regenerated');
  assert.strictEqual(core.refreshClaudeContext(d, { transcript_path: ctxTranscript }).skipped, 'unchanged');
});

test('3MB transcript: original task (head) and recent turn (tail) both present, refresh under 1s', () => {
  const big = path.join(ctxRoot, 'big-transcript.jsonl');
  const fd = fs.openSync(big, 'w');
  const write = (s) => fs.writeSync(fd, s + '\n');
  write(JSON.stringify({ type: 'user', message: { role: 'user', content: 'ORIGINAL TASK MARKER: build the relay' } }));
  const filler = 'x'.repeat(380);
  let bytes = 0;
  let i = 0;
  while (bytes < 3.2 * 1024 * 1024) {
    const line = JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: `filler ${i} ${filler}` }] } });
    fs.writeSync(fd, line + '\n');
    bytes += line.length + 1;
    i++;
  }
  write(JSON.stringify({ type: 'user', message: { role: 'user', content: 'RECENT TURN MARKER: check the tail' } }));
  write(
    JSON.stringify({
      type: 'assistant',
      message: {
        role: 'assistant',
        content: [
          { type: 'text', text: 'LATEST REPLY MARKER' },
          { type: 'tool_use', name: 'Edit', input: { file_path: 'src/recent.js', old_string: 'a', new_string: 'b' } },
        ],
      },
    })
  );
  fs.closeSync(fd);
  const size = fs.statSync(big).size;
  assert.ok(size > 3 * 1024 * 1024, `size ${size}`);
  const d = mkDir('big proj');
  const t0 = Date.now();
  const res = core.refreshClaudeContext(d, { transcript_path: big, session_id: 'big' });
  const ms = Date.now() - t0;
  assert.ok(res.written, JSON.stringify(res));
  assert.strictEqual(res.windowed, true);
  const c = fs.readFileSync(path.join(d, '.claude-relay', 'CLAUDE_CONTEXT.md'), 'utf8');
  assert.ok(c.includes('ORIGINAL TASK MARKER'), 'head read');
  assert.ok(c.includes('RECENT TURN MARKER'), 'tail read');
  assert.ok(c.includes('LATEST REPLY MARKER'));
  assert.ok(c.includes('src/recent.js'));
  assert.ok(ms < 1000, `refresh took ${ms} ms`);
  const h = core.buildHandoff(d, big, new Date());
  assert.ok(h.includes('ORIGINAL TASK MARKER') && h.includes('RECENT TURN MARKER'), 'handoff uses same windows');
  console.log(`       (3MB transcript: ${size} bytes, context refresh ${ms} ms)`);
});

// ---------- fb bridge ----------

const proto = require(path.join(ROOT, 'lib', 'fb-protocol.js'));
const fbChat = require(path.join(ROOT, 'lib', 'fb-chat.js'));
const FB = path.join(ROOT, 'bin', 'fb.js');
const FAKE = path.join(__dirname, 'fake-freebuff.js');

console.log('fb protocol and chat events');

test('line splitter joins frames split across chunks and multi-byte characters', () => {
  const got = [];
  const feed = proto.lineSplitter((l) => got.push(l));
  const buf = Buffer.from('{"a":"é€"}\n{"b":2}\n', 'utf8');
  feed(buf.subarray(0, 9));
  feed(buf.subarray(9, 13));
  feed(buf.subarray(13));
  assert.deepStrictEqual(got, ['{"a":"é€"}', '{"b":2}']);
});

test('bad frames become error objects instead of throwing', () => {
  assert.strictEqual(proto.parseFrame('{nope').type, 'error');
  assert.deepStrictEqual(proto.parseFrame('{"op":"status"}'), { op: 'status' });
});

test('decodeEscapes turns \\r \\n \\e \\xHH into control characters', () => {
  assert.strictEqual(proto.decodeEscapes('a\\rb\\n\\e\\x41\\\\'), 'a\rb\n\x1bA\\');
});

test('endpoint is stable per folder and differs between folders', () => {
  const a = proto.endpointFor(path.join(tmpRoot, 'one'));
  assert.strictEqual(a, proto.endpointFor(path.join(tmpRoot, 'one')));
  assert.notStrictEqual(a, proto.endpointFor(path.join(tmpRoot, 'two')));
  if (process.platform === 'win32') assert.ok(a.startsWith('\\\\.\\pipe\\fb-relay-'));
});

test('Git Bash $PWD (/c/...) is mapped to a Windows path on win32 only', () => {
  if (process.platform === 'win32') assert.strictEqual(proto.toNativePath('/c/Users/x y'), 'C:\\Users\\x y');
  else assert.strictEqual(proto.toNativePath('/c/Users/x y'), '/c/Users/x y');
});

const logFixtureDir = path.join(tmpRoot, 'chat-fixture');
fs.mkdirSync(logFixtureDir, { recursive: true });
const SINCE = Date.parse('2026-11-17T12:00:00.000Z');
const msgs = [
  { id: 'divider-1', variant: 'ai', content: '', blocks: [{ type: 'mode-divider', mode: 'LITE' }] },
  { id: 'user-' + (SINCE - 60000), variant: 'user', content: 'old question' },
  { id: 'ai-old', variant: 'ai', content: '', blocks: [{ type: 'text', content: 'OLD ANSWER' }] },
  { id: 'user-' + (SINCE + 5), variant: 'user', content: 'new question' },
  {
    id: 'ai-new',
    variant: 'ai',
    content: '',
    blocks: [
      { type: 'text', content: 'THINKING TEXT', textType: 'reasoning' },
      { type: 'tool', toolName: 'read_files', input: { path: 'hello.txt' }, output: 'TOOL OUTPUT SECRET' },
      { type: 'text', content: '  visible answer  ', textType: 'text' },
    ],
  },
];

console.log('fb chat events');

test('findUserIndex picks the user message sent at or after the ask time', () => {
  assert.strictEqual(fbChat.findUserIndex(msgs, 'new question', SINCE), 3);
  assert.strictEqual(fbChat.findUserIndex(msgs, 'new question', SINCE + 10000), -1, 'nothing sent after that');
  // Text is only used when a message has no timestamp (TUI may rewrite text, ids are reliable).
  const noIds = [{ id: 'x', variant: 'user', content: 'plain' }];
  assert.strictEqual(fbChat.findUserIndex(noIds, 'plain', SINCE), 0);
  assert.strictEqual(fbChat.findUserIndex(noIds, 'other', SINCE), -1);
});

test('collectEvents: reasoning and tool output never appear; tools stream, text waits for completion', () => {
  const emitted = new Set();
  const early = fbChat.collectEvents(msgs, 3, emitted, false);
  assert.deepStrictEqual(early, [{ type: 'tool', name: 'read_files', arg: 'hello.txt' }]);
  assert.strictEqual(fbChat.toolArg({ paths: ['a.js', 'b.js'] }), 'a.js, b.js');
  const done = fbChat.collectEvents(msgs, 3, emitted, true);
  assert.deepStrictEqual(done, [{ type: 'text', text: 'visible answer' }]);
  const json = JSON.stringify([early, done]);
  assert.ok(!json.includes('THINKING') && !json.includes('TOOL OUTPUT'), json);
  assert.deepStrictEqual(fbChat.collectEvents(msgs, 3, emitted, true), [], 'no repeats');
});

test('collectEvents: a finished earlier message is complete even when not final', () => {
  const m2 = [
    { id: 'user-1', variant: 'user', content: 'q' },
    { id: 'ai-1', variant: 'ai', content: '', blocks: [{ type: 'text', content: 'first part' }] },
    { id: 'ai-2', variant: 'ai', content: '', blocks: [{ type: 'text', content: 'second part' }] },
  ];
  const got = fbChat.collectEvents(m2, 0, new Set(), false);
  assert.deepStrictEqual(got, [{ type: 'text', text: 'first part' }]);
});

test('logSignals: finished and session-over markers are read only after the ask time', () => {
  const iso = (ms) => new Date(ms).toISOString();
  fs.writeFileSync(
    path.join(logFixtureDir, 'log.jsonl'),
    [
      { timestamp: iso(SINCE - 5000), msg: 'Main prompt finished' },
      { timestamp: iso(SINCE + 100), msg: '[chat-runtime] Freebuff session over; holding queued messages until rejoin' },
      { timestamp: iso(SINCE + 2000), msg: '[message-queue] Processing next message from queue' },
      { timestamp: iso(SINCE + 4000), msg: 'Main prompt finished' },
    ]
      .map((o) => JSON.stringify(o))
      .join('\n') + '\n'
  );
  const sig = fbChat.logSignals(logFixtureDir, SINCE);
  assert.strictEqual(sig.finished, true);
  assert.strictEqual(sig.sessionOver, true);
  assert.strictEqual(sig.processing, true);
  const none = fbChat.logSignals(logFixtureDir, SINCE + 10000);
  assert.strictEqual(none.finished, false);
});

console.log('fb MCP server');

test('MCP: initialize echoes the protocol version, tools/list names both tools, unknown method is an error', () => {
  const input = [
    { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {} } },
    { jsonrpc: '2.0', method: 'notifications/initialized' },
    { jsonrpc: '2.0', id: 2, method: 'tools/list' },
    { jsonrpc: '2.0', id: 3, method: 'nope' },
    { jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'freebuff_ask', arguments: {} } },
  ].map((o) => JSON.stringify(o)).join('\n') + '\n';
  const r = spawnSync(process.execPath, [path.join(ROOT, 'lib', 'fb-mcp.js')], { input, encoding: 'utf8', timeout: 30000 });
  const frames = r.stdout.trim().split('\n').map((l) => JSON.parse(l));
  const byId = (id) => frames.find((f) => f.id === id);
  assert.strictEqual(byId(1).result.protocolVersion, '2025-06-18');
  assert.deepStrictEqual(byId(1).result.capabilities, { tools: {} });
  const names = byId(2).result.tools.map((t) => t.name);
  assert.deepStrictEqual(names, ['freebuff_ask', 'freebuff_screen']);
  assert.strictEqual(byId(3).error.code, -32601);
  assert.strictEqual(byId(4).result.isError, true, 'missing message is a tool error, not a crash');
  assert.strictEqual(frames.length, 4, 'notifications get no reply');
});

// End-to-end needs the terminal modules. Skip (not fail) when they are not installed.
let ptyReady = true;
try {
  require(path.join(ROOT, 'lib', 'fb-pty.js')).loadDeps();
} catch (e) {
  ptyReady = false;
}

console.log('fb end to end (fake Freebuff in a PTY)');

if (!ptyReady) {
  console.log(`  skip  end-to-end tests: terminal modules missing. Run: npm install --prefix "${ROOT}"`);
} else {
  const fbEnv = Object.assign({}, process.env, {
    RELAY_FREEBUFF_HOME: fbHome,
    FB_AGENT_CMD: process.execPath,
    FB_AGENT_ARGS: JSON.stringify([FAKE]),
  });
  const fbRun = (args, extraEnv, input) =>
    spawnSync(process.execPath, [FB].concat(args), {
      encoding: 'utf8',
      timeout: 120000,
      input,
      env: Object.assign({}, fbEnv, extraEnv || {}),
    });
  const projA = path.join(tmpRoot, 'fb proj a');
  const projB = path.join(tmpRoot, 'fb proj b');
  fs.mkdirSync(projA, { recursive: true });
  fs.mkdirSync(projB, { recursive: true });
  fs.writeFileSync(path.join(projA, 'hello.txt'), 'hello\n');

  test('fb "message" streams the visible reply; reasoning and tool output stay hidden', () => {
    const r = fbRun(['--cwd', projA, 'hello from the test']);
    assert.strictEqual(r.status, 0, r.stdout + r.stderr);
    assert.ok(r.stdout.includes('FAKE REPLY: hello from the test'), r.stdout);
    assert.ok(r.stdout.includes('→ read_files'), 'tool line shown');
    assert.ok(!/SECRET|THINKING|TOOL OUTPUT/.test(r.stdout + r.stderr), r.stdout);
    assert.ok(!/\x1b\[/.test(r.stdout), 'plain text output');
  });

  test('a second fb message goes to the same Freebuff session (one chat dir)', () => {
    const r = fbRun(['--cwd', projA, 'second message']);
    assert.strictEqual(r.status, 0, r.stdout + r.stderr);
    assert.ok(r.stdout.includes('FAKE REPLY: second message'), r.stdout);
    const chats = fs.readdirSync(path.join(fbHome, 'projects', path.basename(projA), 'chats'));
    assert.strictEqual(chats.length, 1, chats.join(','));
  });

  test('fb status and fb screen work for a running session', () => {
    const st = fbRun(['--cwd', projA, 'status']);
    assert.ok(st.stdout.includes('running for'), st.stdout + st.stderr);
    const sc = fbRun(['--cwd', projA, 'screen', '--lines', '10']);
    assert.ok(sc.stdout.includes('Enter a coding task'), sc.stdout);
  });

  test('a message Freebuff never picks up is reported as stuck with the screen (exit 1)', () => {
    const r = fbRun(['--cwd', projB, 'nobody answers this'], { FB_STUCK_SEC: '3', FAKE_FB_NEVER_PROCESS: '1' });
    assert.strictEqual(r.status, 1, r.stdout + r.stderr);
    assert.ok(r.stdout.includes('never started'), r.stdout);
    assert.ok(r.stdout.includes('nobody answers this'), 'screen shown');
    fbRun(['--cwd', projB, 'stop']);
  });

  test('MCP freebuff_ask returns the reply as tool text', () => {
    const input = [
      { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05' } },
      { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'freebuff_ask', arguments: { message: 'via mcp', cwd: projA } } },
    ].map((o) => JSON.stringify(o)).join('\n') + '\n';
    const r = spawnSync(process.execPath, [path.join(ROOT, 'lib', 'fb-mcp.js')], {
      input,
      encoding: 'utf8',
      timeout: 120000,
      env: fbEnv,
    });
    const res = r.stdout.trim().split('\n').map((l) => JSON.parse(l)).find((f) => f.id === 2);
    assert.strictEqual(res.result.isError, false, JSON.stringify(res));
    assert.ok(res.result.content[0].text.includes('FAKE REPLY: via mcp'), res.result.content[0].text);
  });

  test('fb stop ends the session and status then reports none', () => {
    const stop = fbRun(['--cwd', projA, 'stop']);
    assert.ok(stop.stdout.includes('stopped'), stop.stdout + stop.stderr);
    const st = fbRun(['--cwd', projA, 'status']);
    assert.ok(st.stdout.includes('no Freebuff session'), st.stdout);
    assert.ok(!fs.existsSync(path.join(projA, '.claude-relay', 'fb-daemon.json')), 'pid file removed');
  });
}

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
