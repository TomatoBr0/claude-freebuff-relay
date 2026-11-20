'use strict';
// Freebuff mode: while on for a folder, the UserPromptSubmit hook sends each prompt to the
// hidden Freebuff session and shows its reply (as the hook's block reason) instead of
// calling Claude. Needs no ANTHROPIC_BASE_URL change, so Remote Control keeps working, and
// it works while Claude is rate-limited. Toggle: /fb-model on|off|status.

const fs = require('fs');
const os = require('os');
const path = require('path');

function stateFile() {
  return path.join(process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude'), 'fb-model.json');
}

function read() {
  try {
    const s = JSON.parse(fs.readFileSync(stateFile(), 'utf8').replace(/^﻿/, ''));
    if (s && typeof s === 'object' && s.projects && typeof s.projects === 'object') return s;
  } catch (e) {}
  return { projects: {} };
}

function write(s) {
  fs.mkdirSync(path.dirname(stateFile()), { recursive: true });
  fs.writeFileSync(stateFile(), JSON.stringify(s, null, 2) + '\n');
}

function key(cwd) {
  return path.resolve(cwd).replace(/[\\/]+$/, '').toLowerCase();
}

function isOn(cwd) {
  return !!read().projects[key(cwd)];
}

function set(cwd, on) {
  const s = read();
  if (on) s.projects[key(cwd)] = { since: new Date().toISOString(), session: null };
  else delete s.projects[key(cwd)];
  write(s);
}

// "/fb-model on", "/freebuff-relay:fb-model off", "fb-model" -> 'on' | 'off' | 'status' | null
function parseToggle(prompt) {
  const s = String(prompt || '').replace(/<\/?command-(?:name|message|args)>/g, ' ');
  const m = s.match(/^\s*\/?(?:freebuff-relay:)?fb-model\b\s*(on|off|status)?\b/i);
  return m ? (m[1] || 'status').toLowerCase() : null;
}

function statusText(cwd) {
  return isOn(cwd)
    ? `Freebuff mode is ON for ${cwd}: your messages go to Freebuff, Claude is not called. Turn off with /fb-model off.`
    : `Freebuff mode is OFF for ${cwd}: messages go to Claude. Turn on with /fb-model on.`;
}

function preamble(cwd, fbCwd) {
  return (
    '[Context from Claude Code] The user turned on Freebuff mode in Claude Code: you answer their messages there ' +
    'instead of Claude, and your reply is shown in Claude Code (possibly on their phone via Remote Control). ' +
    (fbCwd !== cwd
      ? `Claude Code runs in their home folder (${cwd}); you are in a scratch workspace (${fbCwd}), so use absolute paths under ${cwd}. `
      : `Project folder: ${cwd}. `) +
    'Slash commands are handled by Claude Code, not you. Work on files directly when asked and keep replies short.' +
    '\n\nThe user\'s message:\n'
  );
}

// Hook entry. Returns a hook output object, or null to let the prompt go to Claude.
async function handlePrompt(input, cwd) {
  const toggle = parseToggle(input.prompt);
  if (toggle) {
    if (toggle === 'on') set(cwd, true);
    if (toggle === 'off') set(cwd, false);
    return { decision: 'block', reason: statusText(cwd) };
  }
  if (!isOn(cwd)) return null;
  const text = String(input.prompt || '').trim();
  if (!text) return null;

  const gw = require('./fb-gateway');
  const client = require('./fb-client');
  const chat = require('./fb-chat');
  const fbCwd = gw.isHomeDir(cwd) ? gw.homeWorkspace() : cwd;

  // Context goes with the first message of each Claude Code session (or a fresh Freebuff session).
  const s = read();
  const entry = s.projects[key(cwd)] || {};
  const running = !!(await client.status(fbCwd).catch(() => null));
  const fresh = !running || entry.session !== (input.session_id || null);
  entry.session = input.session_id || null;
  s.projects[key(cwd)] = entry;
  write(s);

  let out = '';
  try {
    const res = await client.ask(fbCwd, fresh ? preamble(cwd, fbCwd) + text : text, {
      timeoutSec: Number(process.env.FB_ASK_TIMEOUT_SEC) || undefined,
      onEvent: (ev) => (out += chat.formatEvent(ev)),
    });
    if (!res.ok) {
      out += `\n[fb] ${res.final.message || res.final.reason || res.outcome}\n`;
      const tail = (res.final.screen || []).slice(-15).join('\n');
      if (tail) out += `Last screen:\n${tail}\n`;
    }
  } catch (e) {
    out += `\n[fb] ${e && e.message ? e.message : e}\n`;
  }
  return {
    decision: 'block',
    reason: `Freebuff:\n\n${out.trim() || '(Freebuff sent an empty reply)'}\n\n(Freebuff mode on; /fb-model off to go back to Claude)`,
  };
}

module.exports = { handlePrompt, parseToggle, isOn, set, statusText, stateFile };
