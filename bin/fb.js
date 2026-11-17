#!/usr/bin/env node
'use strict';
// fb: send a message to Freebuff and print its reply. Plain text, no model involved, so it
// works from Claude Code's `!` bash mode even when the Claude usage limit is hit.

const fs = require('fs');
const path = require('path');
const client = require('../lib/fb-client');
const chat = require('../lib/fb-chat');
const proto = require('../lib/fb-protocol');

const SUBCOMMANDS = new Set(['screen', 'keys', 'status', 'stop', 'new']);
const TAIL_LINES = 25;

const USAGE = `fb - talk to Freebuff (a free coding agent) from Claude Code or any shell

Usage:
  fb <message...>             send a message, wait, print Freebuff's reply
  fb -                        read the message from stdin
  fb --cwd <dir> ...          use another project folder (default: current folder)
  fb --continue ...           when starting a session, resume the last Freebuff chat
  fb --timeout <sec> ...      give up waiting after this many seconds (default 900)
  fb screen [--lines N]       show the last lines of Freebuff's screen (default 40)
  fb keys "<text>"            press keys in Freebuff (escapes: \\r \\n \\t \\e \\xHH)
  fb status                   show whether a session is running for this folder
  fb stop                     stop the session for this folder
  fb new                      stop and start a fresh session
  fb -- <words>               force the words to be read as a message

Claude Code: "! fb <message>" runs without the model. "/fb <message>" also works.
`;

function parseArgs(argv) {
  const o = { cwd: null, timeoutSec: null, continueArgs: [], words: [], stdin: false, lines: null, help: false };
  let literal = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (literal) {
      o.words.push(a);
    } else if (a === '--') {
      literal = true;
    } else if (a === '--cwd') {
      o.cwd = argv[++i];
    } else if (a.startsWith('--cwd=')) {
      o.cwd = a.slice('--cwd='.length);
    } else if (a === '--continue') {
      o.continueArgs = ['--continue'];
    } else if (a.startsWith('--continue=')) {
      o.continueArgs = ['--continue', a.slice('--continue='.length)];
    } else if (a === '--timeout') {
      o.timeoutSec = Number(argv[++i]);
    } else if (a === '--lines') {
      o.lines = Number(argv[++i]);
    } else if (a === '-') {
      o.stdin = true;
    } else if (a === '-h' || a === '--help') {
      o.help = true;
    } else {
      o.words.push(a);
    }
  }
  return o;
}

function resolveCwd(p) {
  return path.resolve(proto.toNativePath(p || process.cwd()));
}

function printLines(lines) {
  for (const l of lines) process.stdout.write(l + '\n');
}

function printProblem(final) {
  process.stdout.write(`[fb] ${final.reason || final.type}\n`);
  if (final.screen && final.screen.length) {
    process.stdout.write('[fb] last screen:\n');
    printLines(final.screen.slice(-TAIL_LINES));
  }
  process.stdout.write('[fb] Use "fb screen" to see the whole screen, "fb keys \\r" to press Enter, or "fb new" to start over.\n');
}

async function runAsk(cwd, text, o) {
  const t0 = Date.now();
  let res;
  try {
    res = await client.ask(cwd, text, {
      timeoutSec: o.timeoutSec || undefined,
      continueArgs: o.continueArgs,
      onStart: () => process.stderr.write(`fb: started a Freebuff session for ${cwd}\n`),
      onEvent: (ev) => {
        if (ev.type === 'hint') process.stdout.write(`[fb] ${ev.text}\n`);
        else process.stdout.write(chat.formatEvent(ev));
      },
    });
  } catch (e) {
    process.stderr.write(`fb: ${e.message}\n`);
    return 1;
  }
  const secs = ((Date.now() - t0) / 1000).toFixed(1);
  if (res.ok) {
    process.stderr.write(`(Freebuff replied in ${secs}s)\n`);
    return 0;
  }
  if (res.outcome === 'error') {
    process.stderr.write(`fb: ${res.final.message}\n`);
    return 1;
  }
  printProblem(res.final);
  return 1;
}

async function runSubcommand(cmd, words, cwd, o) {
  if (cmd === 'status') {
    const st = await client.status(cwd);
    if (!st) {
      console.log(`fb: no Freebuff session is running for ${cwd}`);
      return 0;
    }
    console.log(`fb: running for ${st.cwd}`);
    console.log(`  daemon pid ${st.pid}, Freebuff pid ${st.freebuffPid}, up ${Math.round(st.uptimeSec / 60)} min`);
    console.log(`  ready: ${st.ready ? 'yes' : 'not yet'}, asking now: ${st.asking ? 'yes' : 'no'}, last ask: ${st.lastAsk || 'none'}`);
    console.log(`  idle exit after ${st.idleExitMin} min without use, chat: ${st.chat || 'none yet'}`);
    return 0;
  }
  if (cmd === 'stop') {
    const was = await client.stop(cwd);
    console.log(was ? `fb: stopped the Freebuff session for ${cwd}` : `fb: no Freebuff session is running for ${cwd}`);
    return 0;
  }
  if (cmd === 'new') {
    const r = await client.newSession(cwd);
    console.log(`fb: started a fresh Freebuff session for ${cwd} (pid ${r.status.freebuffPid})`);
    return 0;
  }
  if (cmd === 'screen') {
    const lines = await client.screen(cwd, o.lines > 0 ? o.lines : 40);
    printLines(lines);
    return 0;
  }
  if (cmd === 'keys') {
    const data = proto.decodeEscapes(words.slice(1).join(' '));
    if (!data) {
      console.error('fb: keys needs text, e.g. fb keys "\\r"');
      return 1;
    }
    const lines = await client.keys(cwd, data);
    printLines(lines.slice(-TAIL_LINES));
    return 0;
  }
  return 1;
}

async function main() {
  const o = parseArgs(process.argv.slice(2));
  if (o.help) {
    process.stdout.write(USAGE);
    return 0;
  }
  if (!o.words.length && !o.stdin) {
    process.stdout.write(USAGE);
    return 1;
  }
  const cwd = resolveCwd(o.cwd);
  const cmd = o.words[0];
  const isSub = !o.stdin && SUBCOMMANDS.has(cmd) && (cmd === 'keys' || o.words.length === 1);
  if (isSub) {
    try {
      return await runSubcommand(cmd, o.words, cwd, o);
    } catch (e) {
      process.stderr.write(`fb: ${e.message}\n`);
      return 1;
    }
  }
  let text = o.stdin ? fs.readFileSync(0, 'utf8') : o.words.join(' ');
  text = text.trim();
  if (!text) {
    process.stderr.write('fb: empty message\n');
    return 1;
  }
  return runAsk(cwd, text, o);
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((err) => {
    process.stderr.write(`fb: ${err && err.message ? err.message : err}\n`);
    process.exitCode = 1;
  });
