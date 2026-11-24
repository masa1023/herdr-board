# herdr-board

A herdr popup that lists every agent session on one screen, ordered by who needs you.

```
 board  6 sessions  │ j/k select │ Space expand │ Enter go/type/send │ x done │ d finished goals │ i idle │ r refresh │ q quit

Needs you (1)  2 open questions
⚠ api/auth       api   feat/token-refresh   #412 open ✓CI   :3000   2/5   ? 2   Rotate refresh tokens
  ┏ Goal 1  active  Rotate refresh tokens
  ┃ Questions 2
  ┃   ? Keep the old tokens valid for 24h?
  ┃       assuming: yes
  ┃   ? Which Redis instance holds the denylist?
  ┃       blocks: writing the migration
  ┃ Tasks 2/5
  ┃   ☑ add the rotation endpoint
  ┃   ☐ migrate existing sessions
  ┗

Working (2)
● web/checkout   web   fix/cart-total       #88 draft …CI   :5173   1/3         Fix rounding in cart total
```

Two kinds of information are shown:

- **Collected automatically**: agent status, workspace/tab, repository, branch, pull request (state, CI, review) and listening ports.
- **Written by the agents**: goals, tasks, open questions and suggested next actions, through the bundled `herdr-board` command.

The second part is what makes it useful with many sessions. Each agent writes its questions down instead of only asking them in its own pane, so nothing is lost when several sessions are waiting for you at once.

## Requirements

- macOS (ports are read with `lsof`)
- herdr 0.9.1 or later
- Node.js 20 or later
- A [Nerd Font](https://www.nerdfonts.com/) in your terminal, for the column icons
- Optional: `gh` (pull request column), `docker` (ports of compose services)

## Install

```sh
herdr plugin install masa1023/herdr-board
```

Bind the popup to a key in `~/.config/herdr/config.toml`:

```toml
[[keys.command]]
key = "prefix+o"
type = "plugin_action"
command = "masa.board.open"
description = "open board popup"
```

Put `herdr-board` on your `PATH` so agents can call it:

```sh
root=$(herdr plugin list --json | jq -r '.. | objects | select(.plugin_id? == "masa.board") | .plugin_root')
ln -sf "$root/cli.mjs" ~/.local/bin/herdr-board
```

The plugin directory can move when you run `herdr plugin update`. If `herdr-board` stops working after an update, run the two lines again.

## Keys

| Key | Action |
|---|---|
| `j` / `k`, arrows | Move the selection |
| `Space` | Expand or collapse the selected session |
| `Enter` on a session | Focus that agent and close the popup |
| `Enter` on a question or task | Type it into that agent's prompt (not submitted) and focus the agent |
| `Enter` on a next action | Send its prompt to the agent |
| `x` | Mark the selected task or question done / not done |
| `d` | Show the last finished goals of expanded sessions |
| `i` | Show or hide idle sessions |
| `r` | Refresh git, pull request and port information now |
| `q`, `Esc` | Close |

The popup opens with the session you were looking at selected and expanded.

## Teaching agents to use it

Agents only write to the board if you tell them to. Add something like this to your agent instructions (`CLAUDE.md`, `AGENTS.md`, …):

```markdown
## board

When running inside herdr (`HERDR_ENV=1`), report the state of your session with `herdr-board`.
The user watches all sessions on one board and answers from there.
Run `herdr-board` for the command list and `herdr-board show` for the current notes and their numbers.

- **Goals**: if a request continues the current goal, add tasks to it; if it is a different topic, add a goal with `goal add`. Do not create a goal for something that takes one or two tool calls.
- **Tasks**: before starting, split the work into 3–7 tasks with `task add`, and run `task done` as each one finishes.
- **Questions**: write a question with `ask` before asking the user. Keep working on whatever does not depend on the answer. Use `--assume` when you proceed on an assumption and `--blocks` when some work cannot proceed. Stop only when everything is waiting. Record the reply with `answer`.
- **Next**: when a goal reaches a natural pause, suggest one to three follow-ups with `next`. The `--prompt` must make sense on its own.
- **Finishing**: when all tasks and questions are settled, run `goal done`; if the goal is abandoned, `goal drop`.
- If `herdr-board` is missing or fails, carry on without it.
```

## `herdr-board`

```
herdr-board show                              print the current notes with their numbers
herdr-board goal add "<goal>"                 add a goal
herdr-board goal hold <g> "<reason>"          put it on hold
herdr-board goal resume <g>                   make it active again
herdr-board goal done <g> "<result>"          finished (moved to the archive file)
herdr-board goal drop <g> "<reason>"          abandoned (moved to the archive file)
herdr-board task add <g> "<task>"
herdr-board task done <g> <n>
herdr-board ask <g> "<question>" [--assume "<working assumption>"] [--blocks "<work that is waiting>"]
herdr-board answer <g> <n> "<answer>"
herdr-board next <g> "<label>" --prompt "<instruction>" [--reason "<why>"]
herdr-board next clear <g>
herdr-board path
```

The session is taken from `CLAUDE_CODE_SESSION_ID`, or from the agent session herdr reports for the current pane. `--session <id>` overrides both.

## Where the notes live

One Markdown file per agent session in `~/.local/state/herdr-board/` (override with `HERDR_BOARD_DIR`):

- `<session-id>.md` — active and on-hold goals
- `<session-id>.done.md` — finished and dropped goals
- `board.log` — the herdr commands the board ran and their errors

Notes of sessions that no longer exist are deleted after 30 days without changes.

## License

MIT
