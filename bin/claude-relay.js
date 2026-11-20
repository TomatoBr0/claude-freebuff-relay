#!/usr/bin/env node
'use strict';
// claude-relay CLI: handoff | sync | import | status | watch | help

const path = require('path');
const core = require('../lib/core');

const USAGE = `claude-relay - share context between Claude Code and Freebuff

Usage:
  claude-relay handoff [--cwd dir] [--transcript path] [--open] [--no-launch]
      Write .claude-relay/HANDOFF.md from a Claude transcript (default: newest
      transcript for cwd under ~/.claude/projects) and switch to Freebuff mode.
      Does not open a Freebuff window; use /fb or freebuff_ask in Claude Code.
      --open opens Freebuff in a new terminal (old behaviour).
  claude-relay sync [--cwd dir]
      Print Freebuff's activity since the handoff, write FREEBUFF_LOG.md and
      switch back to Claude mode.
  claude-relay import [--cwd dir] [--last N] [--since <ISO|24h|3d>] [--list]
      Pull in Freebuff sessions for this project, full history. Default: the
      newest chat. --list only lists matching chats and changes nothing.
  claude-relay status [--cwd dir]
      Print the relay state, Freebuff pointer status and context file age.
  claude-relay watch --cwd dir
      Internal: wait for the limit reset and send a notification.
  claude-relay gateway <run|start|stop|status|install|uninstall>
      Local API gateway so Freebuff is a Claude Code model: /model freebuff.
      install adds ANTHROPIC_BASE_URL + a "Freebuff" /model entry to
      ~/.claude/settings.json and starts the gateway at login (Windows).
      uninstall reverts both. Port: FB_GATEWAY_PORT (default 47823).
  claude-relay fb-model <on|off|status> [--cwd dir]
      Freebuff mode: Freebuff answers prompts in this folder instead of Claude.
  claude-relay help

Environment:
  RELAY_NO_LAUNCH=1          do not open a terminal, touch clipboard, or notify
  RELAY_OPEN_TERMINAL=1      on limit hit, open Freebuff in a new terminal (default: off)
  RELAY_AGENT_CMD=...        agent command to run (default: freebuff)
  RELAY_FREEBUFF_HOME=...    Freebuff config dir (default: ~/.config/manicode)
  RELAY_AUTO_IMPORT=0        disable automatic import of standalone Freebuff sessions
  RELAY_FIRST_LOOKBACK_HOURS first-run lookback window (default: 24)
  RELAY_FREEBUFF_CONTEXT=0   disable the live context file and AGENTS.md pointer
  RELAY_HOME_OVERRIDE=...    treat this directory as the home dir (testing; skip rule)
`;

function parseArgs(argv) {
  const opts = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--cwd') opts.cwd = argv[++i];
    else if (a === '--transcript') opts.transcript = argv[++i];
    else if (a === '--no-launch') opts.noLaunch = true;
    else if (a === '--open') opts.open = true;
    else if (a === '--last') opts.last = parseInt(argv[++i], 10);
    else if (a === '--since') opts.since = argv[++i];
    else if (a === '--list') opts.list = true;
    else if (a === '-h' || a === '--help') opts.help = true;
    else opts._.push(a);
  }
  return opts;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const cmd = opts._[0] || 'help';
  const cwd = path.resolve(opts.cwd || process.cwd());

  switch (cmd) {
    case 'handoff': {
      const transcript = opts.transcript ? path.resolve(opts.transcript) : core.findNewestTranscript(cwd);
      if (!transcript) {
        console.error(`No Claude transcript found for ${cwd}. Pass --transcript <path>.`);
        process.exitCode = 1;
        return;
      }
      const res = core.handleLimit(
        { cwd, transcript_path: transcript, error: 'manual_handoff' },
        { noLaunch: !!opts.noLaunch, open: !!opts.open, transcriptPath: transcript }
      );
      if (res.skipped) {
        console.log('Handoff skipped: a handoff already happened in the last 2 minutes.');
        return;
      }
      console.log(`Handoff written: ${res.handoffPath}`);
      console.log(`Reset: ${res.resetAt || 'unknown'}`);
      console.log('Freebuff reads .claude-relay context automatically via AGENTS.md.');
      if (opts.open) console.log('If it does not pick it up, paste this prompt into Freebuff: ' + core.PROMPT_TEXT);
      else console.log('Continue from Claude Code with /fb <message> or the freebuff_ask tool (no window opened).');
      return;
    }
    case 'sync': {
      const { log, chatCount } = core.manualSync(cwd);
      process.stdout.write(log);
      if (!chatCount) process.stderr.write('(no Freebuff chats newer than the handoff)\n');
      return;
    }
    case 'import': {
      const sinceMs = opts.since != null ? core.parseSinceArg(opts.since) : null;
      if (opts.list) {
        // Read-only: no state or directory writes.
        let rows = core.listChats(cwd, sinceMs);
        if (opts.last > 0) rows = rows.slice(0, opts.last);
        if (!rows.length) {
          console.log('No Freebuff chats found for this project.');
          return;
        }
        for (const r of rows) {
          const when = new Date(r.mtime).toLocaleString();
          const count = r.messageCount == null ? '?' : r.messageCount;
          console.log(`${r.name}  ${when}  ${count} msgs  ${r.firstPrompt}`);
        }
        return;
      }
      const res = core.importChats(cwd, { last: opts.last > 0 ? opts.last : undefined, since: sinceMs });
      process.stdout.write(res.log);
      if (!res.count) process.stderr.write('(no matching Freebuff chats)\n');
      return;
    }
    case 'status': {
      process.stdout.write(core.statusReport(cwd));
      console.log('');
      console.log(JSON.stringify({ state: core.readState(cwd) }, null, 2));
      return;
    }
    case 'watch': {
      await core.watch(cwd);
      return;
    }
    case 'fb-model': {
      const mode = require('../lib/fb-mode');
      const sub = (opts._[1] || 'status').toLowerCase();
      if (sub === 'on') mode.set(cwd, true);
      else if (sub === 'off') mode.set(cwd, false);
      console.log(mode.statusText(cwd));
      return;
    }
    case 'gateway': {
      await require('../lib/fb-gateway-admin').cli(opts._[1] || 'status');
      return;
    }
    case 'help':
    default:
      process.stdout.write(USAGE);
      if (cmd !== 'help') process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error(err && err.stack ? err.stack : String(err));
  process.exitCode = 1;
});
