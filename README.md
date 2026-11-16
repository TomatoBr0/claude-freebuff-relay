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
| `/status` | Show the relay state for this project. |

CLI equivalents: `claude-relay handoff [--cwd d] [--transcript path] [--no-launch]`, `claude-relay sync [--cwd d]`, `claude-relay status [--cwd d]`, `claude-relay help`.

## Environment variables

| Variable | Purpose |
| --- | --- |
| `RELAY_NO_LAUNCH=1` | Do not open a terminal, touch the clipboard, notify, or start the reset watcher. Files are still written. |
| `RELAY_AGENT_CMD` | Command to run in the new terminal (default `freebuff`). |
| `RELAY_FREEBUFF_HOME` | Freebuff config directory that contains `projects/` (default `~/.config/manicode`). |

## How shared context works

- **Claude to Freebuff:** the relay writes `.claude-relay/HANDOFF.md` containing the original task, files Claude edited, the latest todo list, git status and diff stat, and the last ~30 conversation turns. Freebuff is pointed at it via the clipboard prompt.
- **Freebuff to Claude:** Freebuff keeps its chats as local JSON files. On the next prompt or session start, the relay reads chats newer than the handoff, keeps user messages, visible replies and tool-call lines (not reasoning and not tool output), and injects that as context. No summarization step is needed.

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
