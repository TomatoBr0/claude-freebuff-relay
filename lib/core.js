'use strict';
// All relay logic. Hooks (scripts/hook.js) and the CLI (bin/claude-relay.js) call into here.
// Zero dependencies. Must run on Windows, macOS and Linux.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, spawnSync, execFileSync } = require('child_process');

const PROMPT_TEXT = 'Read .claude-relay/HANDOFF.md and continue the task from where Claude left off.';
const HANDOFF_CAP = 60000;
const FREEBUFF_LOG_CAP = 40000;
const CONTEXT_CAP = 20000;
const RECENT_TURNS = 30;
const TURN_CHARS = 1500;
const LIMIT_RE = /(usage|5-hour|weekly|session) limit|limit reached|hit your limit|rate.?limit/i;
const RESET_RE = /reset/i;
const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);
const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

// ---------- small helpers ----------

function trunc(s, n) {
  s = String(s == null ? '' : s);
  return s.length > n ? s.slice(0, n) + '...' : s;
}

function str(v) {
  if (typeof v === 'string') return v;
  if (v && typeof v === 'object') {
    try { return JSON.stringify(v); } catch (e) { return ''; }
  }
  return '';
}

function readStdinJson() {
  let raw = '';
  try { raw = fs.readFileSync(0, 'utf8'); } catch (e) { return {}; }
  try {
    const o = JSON.parse(raw);
    return o && typeof o === 'object' && !Array.isArray(o) ? o : {};
  } catch (e) {
    return {};
  }
}

function resolveCwd(input) {
  const c = input && typeof input.cwd === 'string' && input.cwd ? input.cwd : process.cwd();
  return path.resolve(c);
}

function relayDir(cwd) {
  return path.join(cwd, '.claude-relay');
}

function ensureRelayDir(cwd) {
  const dir = relayDir(cwd);
  fs.mkdirSync(dir, { recursive: true });
  const gi = path.join(dir, '.gitignore');
  if (!fs.existsSync(gi)) fs.writeFileSync(gi, '*\n');
  return dir;
}

function logError(cwd, err) {
  try {
    const dir = ensureRelayDir(cwd);
    const msg = `[${new Date().toISOString()}] ${err && err.stack ? err.stack : String(err)}\n`;
    fs.appendFileSync(path.join(dir, 'errors.log'), msg);
  } catch (e) {
    // nothing else we can do
  }
}

function readState(cwd) {
  try {
    const raw = fs.readFileSync(path.join(relayDir(cwd), 'state.json'), 'utf8');
    const o = JSON.parse(raw);
    return o && typeof o === 'object' ? o : null;
  } catch (e) {
    return null;
  }
}

function writeState(cwd, patch) {
  ensureRelayDir(cwd);
  const cur = readState(cwd) || {};
  const next = Object.assign(
    { mode: 'claude', handoffAt: null, resetAt: null, sessionId: null, transcriptPath: null, lastSyncedAt: null },
    cur,
    patch
  );
  fs.writeFileSync(path.join(relayDir(cwd), 'state.json'), JSON.stringify(next, null, 2) + '\n');
  return next;
}

// ---------- reset time parsing ----------

function toHM(hStr, mStr, ap) {
  let h = parseInt(hStr, 10);
  const m = mStr ? parseInt(mStr, 10) : 0;
  if (Number.isNaN(h) || Number.isNaN(m) || m > 59) return null;
  if (ap) {
    if (h < 1 || h > 12) return null;
    ap = ap.toLowerCase();
    if (ap === 'pm' && h < 12) h += 12;
    if (ap === 'am' && h === 12) h = 0;
  } else if (h > 23) {
    return null;
  }
  return { h, m };
}

// Returns ISO string (local-time interpretation) or null.
function parseResetTime(text, now = new Date()) {
  if (!text) return null;
  const s = String(text);

  // "resets Nov 18, 2pm" / "resets Nov 18 at 2:30 PM"
  const dm = s.match(/resets?\s+(?:at\s+)?(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(?:at\s+)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)?/i);
  if (dm) {
    const month = MONTHS.indexOf(dm[1].toLowerCase());
    const day = parseInt(dm[2], 10);
    const t = toHM(dm[3], dm[4], dm[5]);
    if (t && month >= 0 && day >= 1 && day <= 31) {
      let d = new Date(now.getFullYear(), month, day, t.h, t.m, 0, 0);
      if (d.getTime() <= now.getTime()) d = new Date(now.getFullYear() + 1, month, day, t.h, t.m, 0, 0);
      if (!Number.isNaN(d.getTime())) return d.toISOString();
    }
  }

  // "resets 3pm" / "resets at 3:30 PM" / "resets 15:00"
  const tm = s.match(/resets?\s+(?:at\s+)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)?/i);
  if (tm && (tm[3] || tm[2])) {
    const t = toHM(tm[1], tm[2], tm[3]);
    if (t) {
      const d = new Date(now.getFullYear(), now.getMonth(), now.getDate(), t.h, t.m, 0, 0);
      if (d.getTime() <= now.getTime()) d.setDate(d.getDate() + 1);
      return d.toISOString();
    }
  }
  return null;
}

// ---------- Claude transcript -> handoff ----------

function readTranscript(p) {
  const msgs = [];
  if (!p || !fs.existsSync(p)) return msgs;
  const lines = fs.readFileSync(p, 'utf8').split(/\r?\n/);
  for (const line of lines) {
    if (!line.trim()) continue;
    let o;
    try { o = JSON.parse(line); } catch (e) { continue; }
    if (!o || typeof o !== 'object' || o.isMeta) continue;
    if (o.type !== 'user' && o.type !== 'assistant') continue;
    const msg = o.message;
    if (!msg || typeof msg !== 'object') continue;
    const role = msg.role || o.type;
    const content = msg.content;
    let text = '';
    const tools = [];
    if (typeof content === 'string') {
      text = content;
    } else if (Array.isArray(content)) {
      for (const b of content) {
        if (!b || typeof b !== 'object') continue;
        if (b.type === 'text' && typeof b.text === 'string') {
          text += (text ? '\n' : '') + b.text;
        } else if (b.type === 'tool_use') {
          tools.push(b);
        }
        // tool_result and thinking blocks are deliberately skipped
      }
    }
    msgs.push({ role, text: text.trim(), tools });
  }
  return msgs;
}

function claudeToolLine(b) {
  const name = b.name || 'tool';
  const input = b.input && typeof b.input === 'object' ? b.input : {};
  if (name === 'Bash') return `→ Bash: ${trunc(input.command || '', 120)}`;
  const target = input.file_path || input.notebook_path || input.path || input.pattern || input.url || '';
  return `→ ${name}${target ? ' ' + target : ''}`;
}

function latestTodos(msgs) {
  let todos = null;
  for (const m of msgs) {
    for (const t of m.tools) {
      if (t.name === 'TodoWrite' && t.input && Array.isArray(t.input.todos)) todos = t.input.todos;
    }
  }
  return todos;
}

function gitSnapshot(cwd) {
  const run = (args) => {
    try {
      return execFileSync('git', args, {
        cwd,
        timeout: 5000,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
        windowsHide: true,
      });
    } catch (e) {
      return null;
    }
  };
  const status = run(['status', '--short']);
  if (status === null) return null;
  const stat = run(['diff', '--stat']) || '';
  return { status: status.trimEnd(), stat: stat.trimEnd() };
}

function gitBlock(git) {
  if (!git) return '(not a git repository, or git unavailable)';
  const parts = [];
  parts.push('```\n' + (git.status || '(clean: no changed files)') + '\n```');
  if (git.stat) parts.push('Diff stat:\n```\n' + git.stat + '\n```');
  return parts.join('\n\n');
}

function buildHandoff(cwd, transcriptPath, now) {
  const msgs = readTranscript(transcriptPath);
  const out = [];
  out.push('# Handoff: Claude Code -> Freebuff\n');
  out.push(
    'You are Freebuff taking over from Claude Code, which hit its usage limit. ' +
      'Continue the work below. Keep going in this project; Claude will read your chat history ' +
      "automatically when it comes back, so you don't need to write a summary.\n"
  );
  out.push(`Handoff time: ${now.toISOString()}\n`);

  const first = msgs.find((m) => m.role === 'user' && m.text);
  out.push('## Original task\n');
  out.push(first ? trunc(first.text, 2000) : '(no user request found in transcript)');
  out.push('');

  const files = [];
  for (const m of msgs) {
    for (const t of m.tools) {
      if (!EDIT_TOOLS.has(t.name) || !t.input) continue;
      const f = t.input.file_path || t.input.notebook_path;
      if (typeof f === 'string' && f && !files.includes(f)) files.push(f);
    }
  }
  out.push('## Files Claude touched\n');
  out.push(files.length ? files.map((f) => `- ${f}`).join('\n') : '(none)');
  out.push('');

  const todos = latestTodos(msgs);
  if (todos && todos.length) {
    out.push('## Todo list (latest)\n');
    for (const t of todos) {
      const done = t && t.status === 'completed';
      out.push(`- [${done ? 'x' : ' '}] ${str(t && t.content)}`);
    }
    out.push('');
  }

  out.push('## Git state at handoff\n');
  out.push(gitBlock(gitSnapshot(cwd)));
  out.push('');

  // Build conversation turns: each text message is a turn; tool-only assistant
  // messages merge into the preceding assistant turn.
  const turns = [];
  for (const m of msgs) {
    if (m.role === 'user') {
      if (!m.text) continue;
      turns.push({ who: 'User', lines: [`**User:** ${trunc(m.text, TURN_CHARS)}`] });
    } else {
      const toolLines = m.tools.map(claudeToolLine);
      if (!m.text && !toolLines.length) continue;
      const last = turns[turns.length - 1];
      if (!m.text && last && last.who === 'Claude') {
        last.lines.push(...toolLines);
      } else {
        const lines = [];
        if (m.text) lines.push(`**Claude:** ${trunc(m.text, TURN_CHARS)}`);
        else lines.push('**Claude:** (tool use)');
        lines.push(...toolLines);
        turns.push({ who: 'Claude', lines });
      }
    }
  }
  let recent = turns.slice(-RECENT_TURNS);
  const header = out.join('\n') + '\n## Recent conversation\n\n';
  const renderConv = () => recent.map((t) => t.lines.join('\n')).join('\n\n');
  while (recent.length > 1 && header.length + renderConv().length > HANDOFF_CAP) {
    recent = recent.slice(1);
  }
  let conv = renderConv();
  if (header.length + conv.length > HANDOFF_CAP) conv = conv.slice(-(HANDOFF_CAP - header.length));
  return header + (conv || '(no conversation text)') + '\n';
}

// ---------- clipboard / launch / notify ----------

function copyToClipboard(text) {
  const opts = { input: text, timeout: 3000, windowsHide: true, stdio: ['pipe', 'ignore', 'ignore'] };
  try {
    if (process.platform === 'win32') {
      spawnSync('clip', opts);
    } else if (process.platform === 'darwin') {
      spawnSync('pbcopy', opts);
    } else {
      const wl = spawnSync('wl-copy', opts);
      if (wl.error || wl.status !== 0) spawnSync('xclip', ['-selection', 'clipboard'], opts);
    }
  } catch (e) {
    // ignore
  }
}

function shQuote(s) {
  return "'" + String(s).replace(/'/g, "'\\''") + "'";
}

function agentCommand() {
  return process.env.RELAY_AGENT_CMD || 'freebuff';
}

function commandExists(name) {
  try {
    const r = spawnSync('sh', ['-c', `command -v ${name}`], { stdio: 'ignore' });
    return r.status === 0;
  } catch (e) {
    return false;
  }
}

function detachedSpawn(cmd, args, opts = {}) {
  try {
    const child = spawn(cmd, args, Object.assign({ detached: true, stdio: 'ignore', windowsHide: true }, opts));
    child.on('error', () => {});
    child.unref();
    return true;
  } catch (e) {
    return false;
  }
}

// Opens a new terminal window in cwd running the agent command.
function launchFreebuff(cwd) {
  const agent = agentCommand();
  const dir = path.resolve(cwd);
  try {
    if (process.platform === 'win32') {
      // `start "title" /D "dir" cmd /k <agent>` avoids nested && quoting problems.
      let d = dir;
      if (d.length > 3) d = d.replace(/[\\/]+$/, '');
      return detachedSpawn(
        'cmd.exe',
        ['/d', '/c', 'start', '"Freebuff"', '/D', `"${d}"`, 'cmd', '/k', agent],
        { windowsVerbatimArguments: true }
      );
    }
    if (process.platform === 'darwin') {
      const script = `cd ${shQuote(dir)} && ${agent}`;
      const esc = script.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
      return detachedSpawn('osascript', ['-e', `tell application "Terminal" to do script "${esc}"`, '-e', 'tell application "Terminal" to activate']);
    }
    const inner = `cd ${shQuote(dir)} && ${agent}; exec bash`;
    const terms = [
      ['x-terminal-emulator', ['-e', 'bash', '-lc', inner]],
      ['gnome-terminal', ['--', 'bash', '-lc', inner]],
      ['konsole', ['-e', 'bash', '-lc', inner]],
      ['xterm', ['-e', 'bash', '-lc', inner]],
    ];
    for (const [name, args] of terms) {
      if (commandExists(name)) return detachedSpawn(name, args);
    }
    return false;
  } catch (e) {
    return false;
  }
}

function psEncode(script) {
  return Buffer.from(script, 'utf16le').toString('base64');
}

function notify(title, body) {
  try {
    if (process.platform === 'win32') {
      const t = String(title).replace(/'/g, "''");
      const b = String(body).replace(/'/g, "''");
      const script = [
        'Add-Type -AssemblyName System.Windows.Forms',
        'Add-Type -AssemblyName System.Drawing',
        '$n = New-Object System.Windows.Forms.NotifyIcon',
        '$n.Icon = [System.Drawing.SystemIcons]::Information',
        '$n.Visible = $true',
        `$n.ShowBalloonTip(8000, '${t}', '${b}', [System.Windows.Forms.ToolTipIcon]::Info)`,
        'Start-Sleep -Seconds 9',
        '$n.Dispose()',
      ].join('; ');
      return detachedSpawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-EncodedCommand', psEncode(script)]);
    }
    if (process.platform === 'darwin') {
      const esc = (s) => String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
      return detachedSpawn('osascript', ['-e', `display notification "${esc(body)}" with title "${esc(title)}"`]);
    }
    if (commandExists('notify-send')) return detachedSpawn('notify-send', [String(title), String(body)]);
  } catch (e) {
    // best effort
  }
  return false;
}

function spawnWatcher(cwd) {
  const bin = path.join(__dirname, '..', 'bin', 'claude-relay.js');
  return detachedSpawn(process.execPath, [bin, 'watch', '--cwd', cwd]);
}

// ---------- events ----------

function describeReset(resetAt) {
  if (!resetAt) return 'unknown';
  const d = new Date(resetAt);
  return d.toLocaleString();
}

// Claude limit hit: write handoff, switch to freebuff mode, open Freebuff.
function handleLimit(input, opts = {}) {
  const cwd = resolveCwd(input);
  const noLaunch = !!opts.noLaunch || process.env.RELAY_NO_LAUNCH === '1';
  ensureRelayDir(cwd);
  const now = new Date();
  const prev = readState(cwd);
  if (prev && prev.mode === 'freebuff' && prev.handoffAt && now - Date.parse(prev.handoffAt) < 120000) {
    return { skipped: true, cwd };
  }

  const errText = [input.error, input.error_details, input.last_assistant_message].map(str).filter(Boolean).join('\n');
  const resetAt = parseResetTime(errText, now);
  const transcriptPath = typeof input.transcript_path === 'string' ? input.transcript_path : opts.transcriptPath || null;

  const handoffPath = path.join(relayDir(cwd), 'HANDOFF.md');
  fs.writeFileSync(handoffPath, buildHandoff(cwd, transcriptPath, now));

  writeState(cwd, {
    mode: 'freebuff',
    handoffAt: now.toISOString(),
    resetAt,
    sessionId: input.session_id || (prev && prev.sessionId) || null,
    transcriptPath: transcriptPath || (prev && prev.transcriptPath) || null,
  });

  if (!noLaunch) {
    copyToClipboard(PROMPT_TEXT);
    launchFreebuff(cwd);
    notify('Claude limit hit', `Claude limit hit -> Freebuff opened. Paste the prompt (already on clipboard). Resets: ${describeReset(resetAt)}.`);
    if (resetAt) spawnWatcher(cwd);
  }
  return { cwd, resetAt, handoffPath };
}

// Stop: cheap bookkeeping, plus fallback limit detection.
function handleStop(input) {
  const cwd = resolveCwd(input);
  ensureRelayDir(cwd);
  const last = str(input.last_assistant_message);
  if (last && LIMIT_RE.test(last) && RESET_RE.test(last)) {
    return handleLimit(Object.assign({}, input, { error: input.error || 'rate_limit' }));
  }
  const patch = {};
  if (input.session_id) patch.sessionId = input.session_id;
  if (input.transcript_path) patch.transcriptPath = input.transcript_path;
  writeState(cwd, patch);
  return null;
}

// Gathers Freebuff chats newer than the handoff and renders them as text.
function freebuffHome() {
  return process.env.RELAY_FREEBUFF_HOME || path.join(os.homedir(), '.config', 'manicode');
}

function toolArg(input) {
  if (!input || typeof input !== 'object') return '';
  const v = input.path || input.file_path || input.command;
  return typeof v === 'string' ? trunc(v, 120) : '';
}

function renderFreebuffChat(messages) {
  const out = [];
  if (!Array.isArray(messages)) return out;
  for (const m of messages) {
    if (!m || typeof m !== 'object') continue;
    if (m.variant === 'user') {
      const t = typeof m.content === 'string' ? m.content.trim() : '';
      if (t) out.push(`**User:** ${trunc(t, TURN_CHARS)}`);
    } else if (m.variant === 'ai') {
      if (Array.isArray(m.blocks) && m.blocks.length) {
        for (const b of m.blocks) {
          if (!b || typeof b !== 'object') continue;
          if (b.type === 'text') {
            if (b.thinkingId || b.textType === 'reasoning' || b.textType === 'thinking') continue;
            const t = typeof b.content === 'string' ? b.content.trim() : '';
            if (t) out.push(`**Freebuff:** ${trunc(t, TURN_CHARS)}`);
          } else if (b.type === 'tool') {
            out.push(`→ ${b.toolName || 'tool'} ${toolArg(b.input)}`.trimEnd());
          }
          // mode-divider and unknown block types are skipped; tool output is never included
        }
      } else if (typeof m.content === 'string' && m.content.trim()) {
        out.push(`**Freebuff:** ${trunc(m.content.trim(), TURN_CHARS)}`);
      }
    }
  }
  return out;
}

function collectFreebuffChats(cwd, state) {
  const dir = path.join(freebuffHome(), 'projects', path.basename(path.resolve(cwd)), 'chats');
  const since = state && state.handoffAt ? Date.parse(state.handoffAt) || 0 : 0;
  let names = [];
  try { names = fs.readdirSync(dir); } catch (e) { return []; }
  const found = [];
  for (const name of names) {
    const file = path.join(dir, name, 'chat-messages.json');
    try {
      const st = fs.statSync(file);
      if (st.mtimeMs > since) found.push({ name, file, mtime: st.mtimeMs });
    } catch (e) {
      // not a chat dir
    }
  }
  found.sort((a, b) => a.mtime - b.mtime);
  const chats = [];
  for (const f of found) {
    let msgs;
    try { msgs = JSON.parse(fs.readFileSync(f.file, 'utf8')); } catch (e) { continue; }
    const lines = renderFreebuffChat(msgs);
    if (lines.length) chats.push({ name: f.name, lines });
  }
  return chats;
}

// Builds FREEBUFF_LOG.md text and writes it. Returns { log, chatCount }.
function performSync(cwd, state) {
  const chats = collectFreebuffChats(cwd, state);
  const git = gitSnapshot(cwd);
  const header =
    `# Freebuff activity log\n\nHandoff at: ${(state && state.handoffAt) || 'unknown'}\n\n` +
    `## Git state now\n\n${gitBlock(git)}\n\n## Freebuff conversation\n\n`;
  const sections = chats.map((c) => `### Chat ${c.name}\n\n${c.lines.join('\n\n')}`);
  let body = sections.length ? sections.join('\n\n') : '(no Freebuff activity found)';
  const room = FREEBUFF_LOG_CAP - header.length;
  if (body.length > room) body = '...(older activity trimmed)\n\n' + body.slice(-(room - 40));
  const log = header + body + '\n';
  ensureRelayDir(cwd);
  fs.writeFileSync(path.join(relayDir(cwd), 'FREEBUFF_LOG.md'), log);
  return { log, chatCount: chats.length };
}

function capContext(text) {
  if (text.length <= CONTEXT_CAP) return text;
  const note = '\n...[middle truncated; full log at .claude-relay/FREEBUFF_LOG.md]...\n';
  const head = Math.floor((CONTEXT_CAP - note.length) * 0.3);
  const tail = CONTEXT_CAP - note.length - head;
  return text.slice(0, head) + note + text.slice(text.length - tail);
}

const CONTEXT_PREAMBLE =
  'While you were rate-limited, Freebuff continued this task. Here is what it did (from its chat history) plus the current git state. ' +
  'Review the changes and continue seamlessly; briefly tell the user what Freebuff did.\n\n';

// Runs a sync for a freebuff-mode project. Returns additionalContext string or null.
function syncForPrompt(cwd, state) {
  const { log, chatCount } = performSync(cwd, state);
  const now = Date.now();
  if (chatCount > 0) {
    writeState(cwd, { mode: 'claude', lastSyncedAt: new Date(now).toISOString() });
    return capContext(CONTEXT_PREAMBLE + log + '\n(Full log: .claude-relay/FREEBUFF_LOG.md)');
  }
  // No Freebuff activity recorded.
  const resetPassed = !state.resetAt || now >= Date.parse(state.resetAt);
  if (resetPassed) {
    writeState(cwd, { mode: 'claude', lastSyncedAt: new Date(now).toISOString() });
    return `Relay: limit handoff happened at ${state.handoffAt} but Freebuff has no recorded activity.`;
  }
  return null;
}

// session-start / prompt hook logic. Returns hook output object or null.
function handleSessionOrPrompt(event, input) {
  const cwd = resolveCwd(input);
  const state = readState(cwd);
  if (!state || state.mode !== 'freebuff') return null;
  const context = syncForPrompt(cwd, state);
  if (!context) return null;
  return {
    hookSpecificOutput: {
      hookEventName: event === 'session-start' ? 'SessionStart' : 'UserPromptSubmit',
      additionalContext: context,
    },
  };
}

// Manual CLI sync: returns log text and resets mode to claude.
function manualSync(cwd) {
  const state = readState(cwd) || writeState(cwd, {});
  const { log, chatCount } = performSync(cwd, state);
  writeState(cwd, { mode: 'claude', lastSyncedAt: new Date().toISOString() });
  return { log, chatCount };
}

// Background watcher: notify when the limit resets, then exit.
async function watch(cwd) {
  for (;;) {
    const st = readState(cwd);
    if (!st || st.mode !== 'freebuff' || !st.resetAt) return false;
    const remaining = Date.parse(st.resetAt) - Date.now();
    if (remaining <= 0) {
      notify(
        'Claude limit reset',
        "Claude limit has reset — go back to Claude; it will pick up Freebuff's work automatically."
      );
      return true;
    }
    await new Promise((r) => setTimeout(r, Math.min(remaining, 60000)));
  }
}

function findNewestTranscript(cwd) {
  const slug = path.resolve(cwd).replace(/[^a-zA-Z0-9]/g, '-');
  const dir = path.join(os.homedir(), '.claude', 'projects', slug);
  let best = null;
  try {
    for (const f of fs.readdirSync(dir)) {
      if (!f.endsWith('.jsonl')) continue;
      const p = path.join(dir, f);
      const mtime = fs.statSync(p).mtimeMs;
      if (!best || mtime > best.mtime) best = { p, mtime };
    }
  } catch (e) {
    return null;
  }
  return best ? best.p : null;
}

module.exports = {
  PROMPT_TEXT,
  parseResetTime,
  readStdinJson,
  resolveCwd,
  relayDir,
  ensureRelayDir,
  readState,
  writeState,
  logError,
  buildHandoff,
  renderFreebuffChat,
  handleLimit,
  handleStop,
  handleSessionOrPrompt,
  manualSync,
  performSync,
  watch,
  launchFreebuff,
  copyToClipboard,
  notify,
  findNewestTranscript,
  freebuffHome,
};
