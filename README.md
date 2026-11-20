# claude-freebuff-relay

A Claude Code plugin (plus a tiny CLI) that keeps you working when you hit your Claude usage limit.

- **Limit hit:** the relay writes a handoff file for the project, and keeps [Freebuff](https://www.npmjs.com/package/freebuff) inside Claude Code: use `/fb <message>` or the `freebuff_ask` MCP tool, which drive a hidden Freebuff session. No window opens unless `RELAY_OPEN_TERMINAL=1` (or `claude-relay handoff --open`).
- **Limit resets:** when you talk to Claude again, Freebuff's chat activity and the current git state are injected into Claude's context automatically. Claude reviews the changes and continues.

```
Claude hits limit ──► StopFailure hook ──► .claude-relay/HANDOFF.md
                                      ├──► clipboard: "Read .claude-relay/HANDOFF.md ..."
                                      ├──► new terminal running `freebuff`
                                      └──► watcher waits for the reset, then notifies you

Freebuff reads .claude-relay context on its own (via AGENTS.md), so no paste is needed
                                      │
Limit resets, you send a message to Claude
  UserPromptSubmit / SessionStart hook ──► reads Freebuff's local chat files
                                      ──► injects a summary + git state, writes FREEBUFF_LOG.md
```

## Install

Inside Claude Code:

```
/plugin marketplace add TomatoBr0/claude-freebuff-relay
/plugin install freebuff-relay@freebuff-relay
```

Prerequisites: Node.js 18+ and Freebuff.

```
npm i -g freebuff
freebuff login
```

Optional standalone CLI:

```
npm i -g github:TomatoBr0/claude-freebuff-relay
```

## Commands

| Command | What it does |
| --- | --- |
| `/fb-handoff` | Hand the current task to Freebuff now, without waiting for a limit. |
| `/fb-sync` | Pull Freebuff's recent work into this Claude session and switch back to Claude mode. |
| `/fb-import` | Pull in what you did in recent Freebuff sessions for this project (newest chat by default). |
| `/fb-status` | Show the relay state for this project. |

### Freebuff as a model: `/model freebuff`

A small local gateway makes Freebuff selectable in Claude Code's model picker:

```
node bin/claude-relay.js gateway install   # once: starts the gateway, and at login (Windows)
npm link                                   # once: puts claude-fb on PATH
claude-fb                                  # Claude Code on Freebuff; /model opus and back work inside
```

`claude-fb` sets `ANTHROPIC_BASE_URL=http://127.0.0.1:47823` and a "Freebuff" `/model` entry
(`ANTHROPIC_CUSTOM_MODEL_OPTION`) for that session only. Extra arguments go to `claude`.

**Remote Control:** Claude Code (v2.1.196+) turns Remote Control off whenever
`ANTHROPIC_BASE_URL` points anywhere but `api.anthropic.com`. So plain `claude` sessions
stay on Anthropic and keep Remote Control; `claude-fb` sessions cannot be remote-controlled.
From a Remote Control session (e.g. the mobile app) use `/fb <message>` or the `freebuff_ask`
tool instead; those talk to Freebuff without changing the base URL.

`gateway install --global` writes the env into `~/.claude/settings.json` instead
(backup: `settings.json.bak-fb-gateway`), so `/model freebuff` works in every session, at the
cost of Remote Control everywhere. Plain `gateway install` removes that global env again.
The SessionStart hook restarts the gateway if a session uses it and it is down.

- Requests for `model: freebuff` go to the same hidden Freebuff session `/fb` uses (one per
  project folder, taken from Claude Code's "Primary working directory"). Freebuff edits files
  itself; its reply streams back as the assistant message. Claude tools are not used.
- Everything else is passed through to `api.anthropic.com` unchanged (Authorization and
  `anthropic-beta` included), so your claude.ai login and other models work as before.
- Tool-less background requests (titles, summaries) made while on `freebuff` go to
  `claude-haiku-4-5` (`FB_GATEWAY_BG_MODEL`).
- Freebuff will not open the home folder as a project (it stops at a folder picker), so a Claude
  Code session started in `~` runs Freebuff in a scratch workspace, `~/.claude/freebuff-home`
  (`FB_GATEWAY_HOME_WORKSPACE`), and tells it the user's files are under the home folder.
- `gateway status | start | stop | uninstall`. `uninstall` removes the env vars and launcher.
  If the gateway is down while installed, Claude Code cannot reach the API: run
  `node bin/claude-relay.js gateway start` or `gateway uninstall`.

CLI equivalents: `claude-relay handoff [--cwd d] [--transcript path] [--open] [--no-launch]`, `claude-relay sync [--cwd d]`, `claude-relay status [--cwd d]`, `claude-relay help`.

## Environment variables

| Variable | Purpose |
| --- | --- |
| `RELAY_OPEN_TERMINAL=1` | On limit hit, also open Freebuff in a new terminal and copy the prompt to the clipboard. Off by default: Freebuff is used from Claude Code via `/fb` / `freebuff_ask`. |
| `RELAY_NO_LAUNCH=1` | Do not open a terminal, touch the clipboard, notify, or start the reset watcher. Files are still written. |
| `RELAY_AGENT_CMD` | Command to run in the new terminal (default `freebuff`). |
| `RELAY_FREEBUFF_HOME` | Freebuff config directory that contains `projects/` (default `~/.config/manicode`). |
| `RELAY_AUTO_IMPORT=0` | Disable automatic import of standalone Freebuff sessions. |
| `RELAY_FIRST_LOOKBACK_HOURS` | First-run lookback for automatic import, in hours (default `24`). |
| `RELAY_FREEBUFF_CONTEXT=0` | Disable the live context file and the AGENTS.md pointer. |
| `RELAY_HOME_OVERRIDE` | Testing aid: treat this directory as your home directory for the skip rule. |

## How shared context works

- **Claude to Freebuff:** the relay writes `.claude-relay/HANDOFF.md` containing the original task, files Claude edited, the latest todo list, git status and diff stat, and the last ~30 conversation turns. The clipboard prompt still points Freebuff at it, but the paste is optional now (see below).
- **Freebuff to Claude:** Freebuff keeps its chats as local JSON files. On the next prompt or session start, the relay reads chats newer than the handoff, keeps user messages, visible replies and tool-call lines (not reasoning and not tool output), and injects that as context. No summarization step is needed.

## Picking up plain Freebuff sessions

You don't have to hit a limit to use this. Any Freebuff session you ran in a project directory is picked up automatically the next time you talk to Claude there, so you never need to ask Freebuff for notes.

- **Matching:** Freebuff stores each chat with the project root it ran in (`run-state.json`). Only chats whose root matches the current directory are used, so two projects with the same folder name stay separate. Chats without that metadata are kept.
- **Automatic:** on session start and on each prompt, the relay looks for matching chats modified since the last sync. The first time in a project it only looks back 24 hours (`RELAY_FIRST_LOOKBACK_HOURS`). Each Freebuff chat is imported incrementally: a chat that is still open and gets new messages later contributes only the new ones.
- **Cheap when idle:** when nothing changed, the check is a few `stat()` calls per prompt.
- **On demand:** `/fb-import` (or `claude-relay import`) pulls in the newest chat in full. Options: `--last N`, `--since 24h|3d|<ISO>`, `--list` (read-only listing with message counts and the first prompt).
- **Off switch:** `RELAY_AUTO_IMPORT=0` disables automatic import. The limit handoff flow still works.

## Freebuff sees Claude's context too

Freebuff automatically loads one instructions file from the project root into its system prompt: `AGENTS.md`, or `CLAUDE.md` when there is no `AGENTS.md`. The relay uses that to keep Freebuff in the loop at all times, not only after a limit:

- **`.claude-relay/CLAUDE_CONTEXT.md`** is refreshed on every Claude turn (the `Stop` hook). It holds the original task, files Claude touched, the latest todos, git state, and the last 20 turns. Very large transcripts are read by window (the first 256 KB and the last 2 MB), so refreshes stay fast. Regeneration is skipped when the transcript has not changed.
- **A pointer in `AGENTS.md`** tells Freebuff to read `CLAUDE_CONTEXT.md`, and to read `HANDOFF.md` if Claude hit its limit.
  - If you have your own `AGENTS.md`, the relay appends one marker block (`<!-- claude-relay:start -->` ... `:end -->`) once and leaves the rest of the file alone.
  - Otherwise the relay generates `AGENTS.md`. It starts with a `generated by claude-freebuff-relay` marker line, mirrors your `CLAUDE.md` (because `AGENTS.md` takes precedence over it), and then adds the pointer block. It is only ever overwritten when it carries that marker.
  - In a git repo, the generated `AGENTS.md` and `.claude-relay/` are added to `.git/info/exclude`, so they stay out of your commits. Outside a repo, delete the file any time.
- **The paste is now optional.** Freebuff reads `AGENTS.md` by itself, so you can skip pasting the handoff prompt. It is still copied to the clipboard in case you want it.
- **No `AGENTS.md` pointer in your home directory** (too broad — it would apply to every Freebuff/Codex run there). The live context file and auto-import still work in home. Turn it all off with `RELAY_FREEBUFF_CONTEXT=0`.
- `/fb-status` shows whether the pointer is installed, which file holds it, and when `CLAUDE_CONTEXT.md` was last updated.

## Talk to Freebuff from Claude Code

Send a message to a Freebuff session that runs in the background for this project, and read the reply. Freebuff does the work, so Claude's tokens are not spent.

```
! fb fix the failing test          # bash mode: no model involved, works when you hit the Claude limit
/fb fix the failing test           # same, but Claude then shows the reply (needs Claude to be running)
fb screen                          # what Freebuff's screen shows right now
fb keys "\r"                       # press keys in Freebuff (\r Enter, \x1b Esc, \x15 Ctrl-U)
fb status | fb stop | fb new       # session for this folder: check, end, start fresh
```

- **Claude can delegate too.** The plugin registers an MCP server with two tools: `freebuff_ask` (send a task, get the full reply) and `freebuff_screen`. Ask Claude to hand a cheap, self-contained job to Freebuff.
- **One session per folder.** The first `fb` starts Freebuff in a PTY (about 5 seconds); later messages reuse it. The session exits after 30 minutes without use (`FB_IDLE_MIN`). If you end the session inside Freebuff (its "End session" key), the next `fb` starts a new one.
- **Output.** Plain text. Freebuff's text replies and tool-call lines (`→ read_files hello.txt`). Reasoning and tool output are never printed. Replies print when Freebuff finishes each message; tool lines print as they run.
- **Stuck sessions.** If Freebuff shows a login, rejoin or queue screen, `fb` stops waiting and prints the last screen lines with the next steps. Use `fb screen`, then `fb keys "\r"` or `fb new`.
- **`/fb` shell caveat.** `/fb` puts your arguments into the shell, so quotes and `$` are interpreted. For messages with special characters use `! fb ...`, or pipe the text in: `printf '%s' "..." | fb -`.
- **Multi-line messages** work with stdin (`fb -`) and `fb keys` with bracketed paste. Message text is typed as a paste, then Enter is sent.

Setup (GitHub and marketplace installs do not run `npm install`):

```
cd "<plugin dir>"
npm install          # @xterm/headless, plus @lydell/node-pty for Windows and other platforms with prebuilds
npm link             # optional: puts `fb` on your PATH (or run: node "<plugin dir>/bin/fb.js")
```

If the terminal modules are missing, `fb` prints the exact `npm install --prefix "<plugin dir>"` command to run.

| Variable | Purpose |
| --- | --- |
| `FB_IDLE_MIN` | Minutes without use before the session exits (default `30`). |
| `FB_ASK_TIMEOUT_SEC` | How long one message may take before `fb` gives up and shows the screen (default `900`). |
| `FB_STUCK_SEC` | Seconds Freebuff may take to pick up a message before it is reported stuck (default `45`). |
| `FB_AGENT_CMD` / `FB_AGENT_ARGS` | Replace the Freebuff command (JSON array of args). Used by the tests. |

How replies are read: the session writes its chats to disk. `fb` watches the chat that holds your message, and it is done when Freebuff's log says the prompt finished and the screen no longer shows "thinking...". The screen is only used for busy detection and diagnostics.

Known limits (checked on Freebuff 0.2.36):

- `fb --continue` and `fb --continue=<chat id>` start a **new** chat; they do not resume the old one. Resume is not working in this Freebuff version.
- Freebuff's chat format and log messages are internal and may change. The completion markers are the most likely thing to break; the screen fallback covers some of that.
- Tested on Windows 11 with the real Freebuff. macOS and Linux use the same PTY code through node-pty but were not run against Freebuff here.
- Windows launches `freebuff.exe` directly. If it is missing, it runs the npm package entry with node. The `freebuff.cmd` shim through cmd.exe was tried and fails on paths with spaces, so it is the last resort.

## Limitations

- Freebuff has no non-interactive mode. Automatic context works through `AGENTS.md`, so the paste is only a fallback.
- Limit detection relies on Claude Code's `StopFailure` hook (matcher `rate_limit`), with a fallback that scans the last assistant message on `Stop`.
- Reset times are parsed from the limit message ("resets 3pm", "resets Nov 18, 2pm"). If none is found, the reset is treated as unknown and the watcher does not notify.
- Linux needs a supported terminal emulator (`x-terminal-emulator`, `gnome-terminal`, `konsole`, or `xterm`) and optionally `wl-copy`/`xclip` and `notify-send`.
- `.claude-relay/` is self-ignored (it writes its own `.gitignore` containing `*`).

## Development

```
node test/run.js
```

The relay itself (hooks and `claude-relay`) has no npm dependencies. The `fb` bridge uses `@xterm/headless` and the optional `@lydell/node-pty`. CommonJS only.

## License

MIT
