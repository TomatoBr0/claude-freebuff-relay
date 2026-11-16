#!/usr/bin/env node
'use strict';
// claude-relay CLI: handoff | sync | status | watch | help

const fs = require('fs');
const path = require('path');
const core = require('../lib/core');

const USAGE = `claude-relay - hand off between Claude Code and Freebuff when a Claude limit hits

Usage:
  claude-relay handoff [--cwd dir] [--transcript path] [--no-launch]
      Write .claude-relay/HANDOFF.md from a Claude transcript (default: newest
      transcript for cwd under ~/.claude/projects) and switch to Freebuff mode.
  claude-relay sync [--cwd dir]
      Print Freebuff's activity since the handoff, write FREEBUFF_LOG.md and
      switch back to Claude mode.
  claude-relay status [--cwd dir]
      Print the relay state for the project.
  claude-relay watch --cwd dir
      Internal: wait for the limit reset and send a notification.
  claude-relay help

Environment:
  RELAY_NO_LAUNCH=1       do not open a terminal, touch clipboard, or notify
  RELAY_AGENT_CMD=...     agent command to run (default: freebuff)
  RELAY_FREEBUFF_HOME=... Freebuff config dir (default: ~/.config/manicode)
`;

function parseArgs(argv) {
  const opts = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--cwd') opts.cwd = argv[++i];
    else if (a === '--transcript') opts.transcript = argv[++i];
    else if (a === '--no-launch') opts.noLaunch = true;
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
        { noLaunch: !!opts.noLaunch, transcriptPath: transcript }
      );
      if (res.skipped) {
        console.log('Handoff skipped: a handoff already happened in the last 2 minutes.');
        return;
      }
      console.log(`Handoff written: ${res.handoffPath}`);
      console.log(`Reset: ${res.resetAt || 'unknown'}`);
      console.log('Paste this prompt into Freebuff: ' + core.PROMPT_TEXT);
      return;
    }
    case 'sync': {
      const state = core.readState(cwd) || core.writeState(cwd, {});
      const { log, chatCount } = core.manualSync(cwd);
      process.stdout.write(log);
      if (!chatCount) process.stderr.write('(no Freebuff chats newer than the handoff)\n');
      void state;
      return;
    }
    case 'status': {
      const state = core.readState(cwd);
      console.log(JSON.stringify({ cwd, relayDir: core.relayDir(cwd), state }, null, 2));
      return;
    }
    case 'watch': {
      await core.watch(cwd);
      return;
    }
    case 'help':
    default:
      process.stdout.write(USAGE);
      if (cmd !== 'help') process.exitCode = 1;
  }
  void fs;
}

main().catch((err) => {
  console.error(err && err.stack ? err.stack : String(err));
  process.exitCode = 1;
});
