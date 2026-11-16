# claude-freebuff-relay

A Claude Code plugin (plus a tiny CLI) that keeps you working when you hit your Claude usage limit.

- **Limit hit:** the relay writes a handoff file for the project, copies a prompt to your clipboard, and opens [Freebuff](https://www.npmjs.com/package/freebuff) in a new terminal in the same directory.
- **Limit resets:** when you talk to Claude again, Freebuff's chat activity and the current git state are injected into Claude's context automatically. Claude reviews the changes and continues.

```
Claude hits limit ──► StopFailure hook ──► .claude-relay/HANDOFF.md
                                      ├──► clipboard: "Read .claude-relay/HANDOFF.md ..."
                                      ├──► new terminal running `freebuff`
                                      └──► watcher waits for the reset, then notifies you

You paste the prompt into Freebuff and work
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
| `/handoff` | Hand the current task to Freebuff now, without waiting for a limit. |
| `/sync` | Pull Freebuff's recent work into this Claude session and switch back to Claude mode. |
| `/import` | Pull in what you did in recent Freebuff sessions for this project (newest chat by default). |
| `/status` | Show the relay state for this project. |

CLI equivalents: `claude-relay handoff [--cwd d] [--transcript path] [--no-launch]`, `claude-relay sync [--cwd d]`, `claude-relay status [--cwd d]`, `claude-relay help`.

## Environment variables

| Variable | Purpose |
| --- | --- |
| `RELAY_NO_LAUNCH=1` | Do not open a terminal, touch the clipboard, notify, or start the reset watcher. Files are still written. |
| `RELAY_AGENT_CMD` | Command to run in the new terminal (default `freebuff`). |
| `RELAY_FREEBUFF_HOME` | Freebuff config directory that contains `projects/` (default `~/.config/manicode`). |
| `RELAY_AUTO_IMPORT=0` | Disable automatic import of standalone Freebuff sessions. |
| `RELAY_FIRST_LOOKBACK_HOURS` | First-run lookback for automatic import, in hours (default `24`). |

## How shared context works

- **Claude to Freebuff:** the relay writes `.claude-relay/HANDOFF.md` containing the original task, files Claude edited, the latest todo list, git status and diff stat, and the last ~30 conversation turns. Freebuff is pointed at it via the clipboard prompt.
- **Freebuff to Claude:** Freebuff keeps its chats as local JSON files. On the next prompt or session start, the relay reads chats newer than the handoff, keeps user messages, visible replies and tool-call lines (not reasoning and not tool output), and injects that as context. No summarization step is needed.

## Picking up plain Freebuff sessions

You don't have to hit a limit to use this. Any Freebuff session you ran in a project directory is picked up automatically the next time you talk to Claude there, so you never need to ask Freebuff for notes.

- **Matching:** Freebuff stores each chat with the project root it ran in (`run-state.json`). Only chats whose root matches the current directory are used, so two projects with the same folder name stay separate. Chats without that metadata are kept.
- **Automatic:** on session start and on each prompt, the relay looks for matching chats modified since the last sync. The first time in a project it only looks back 24 hours (`RELAY_FIRST_LOOKBACK_HOURS`). Each Freebuff chat is imported incrementally: a chat that is still open and gets new messages later contributes only the new ones.
- **Cheap when idle:** when nothing changed, the check is a few `stat()` calls per prompt.
- **On demand:** `/import` (or `claude-relay import`) pulls in the newest chat in full. Options: `--last N`, `--since 24h|3d|<ISO>`, `--list` (read-only listing with message counts and the first prompt).
- **Off switch:** `RELAY_AUTO_IMPORT=0` disables automatic import. The limit handoff flow still works.

## Limitations

- Freebuff has no non-interactive mode, so you paste the prompt into it once.
- Limit detection relies on Claude Code's `StopFailure` hook (matcher `rate_limit`), with a fallback that scans the last assistant message on `Stop`.
- Reset times are parsed from the limit message ("resets 3pm", "resets Nov 18, 2pm"). If none is found, the reset is treated as unknown and the watcher does not notify.
- Linux needs a supported terminal emulator (`x-terminal-emulator`, `gnome-terminal`, `konsole`, or `xterm`) and optionally `wl-copy`/`xclip` and `notify-send`.
- `.claude-relay/` is self-ignored (it writes its own `.gitignore` containing `*`).

## Development

```
node test/run.js
```

No npm dependencies. CommonJS only.

## License

MIT
