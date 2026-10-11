# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Running the CLI

```sh
export GODSPEED_API_KEY=your_key_here
./gs <command>
```

To install on PATH:
```sh
ln -s $(pwd)/gs /usr/local/bin/gs
```

## Architecture

The entire CLI is a single Babashka script (`gs`). No build step, no dependencies to install — Babashka ships with `babashka.http-client` and `cheshire` (JSON) built in.

### MCP server (`gs-mcp`)

`gs-mcp` is a second Babashka script: a stdio MCP server for Claude Desktop (hand-rolled JSON-RPC: `initialize`, `tools/list`, `tools/call`). Tools: `list_lists`, `list_tasks`, `add_task`, `complete_task`, `delete_task`. Unlike `gs`, it works by full task id, not fuzzy title. It duplicates the API helpers from `gs` (the scripts don't share code), so API fixes must be made in both. stdout is reserved for JSON-RPC; never print anything else to it. Labels are not supported.

Claude Desktop config (`~/Library/Application Support/Claude/claude_desktop_config.json`):
```json
{"mcpServers": {"godspeed": {"command": "/absolute/path/to/gs-mcp", "env": {"GODSPEED_API_KEY": "..."}}}}
```
If Desktop can't find `bb`, use `"command": "/opt/homebrew/bin/bb"` with `"args": ["/absolute/path/to/gs-mcp"]`.

### API

- Base URL: `https://api.godspeedapp.com`
- Auth: `Authorization: Bearer $GODSPEED_API_KEY`
- Endpoints used: `GET /tasks`, `POST /tasks`, `PATCH /tasks/{id}`, `DELETE /tasks/{id}`, `GET /lists`
- `GET /tasks` is called with `status` (default `incomplete`) and `limit=250`; there is no pagination, so results beyond 250 are not seen
- Responses may be wrapped (`{:tasks [...]}` / `{:lists [...]}`) or a bare array; `fetch-tasks`/`fetch-lists` handle both
- Key fields on tasks: `id`, `title`, `list_id`, `indent_level`, `order_index`, `timeless_due_at`, `label_ids`
- Key fields on lists: `id`, `name`, `list_type` (`"list"`, `"inbox"`, `"smart"`, `"folder"`)
- Only `list_type: "list"` and `"inbox"` can be queried by `list_id`; smart lists and folders cannot
- Completion is `PATCH {is_complete: true}`
- Due dates: read `timeless_due_at` (date-only) or `due_at` (timed); create with `timeless_due_at`. A `due_date` field is silently ignored by the API (verified).
- Known issue: `gs add --label` sends `label`, which the API silently ignores (verified); tasks have `label_ids` (UUIDs), so labels need a name→id lookup that isn't implemented.

### Task hierarchy

Tasks have no `parent_id`. Subtask relationships are encoded positionally via `order_index` (sort order) and `indent_level` (nesting depth). To display hierarchy, sort by `order_index` and indent by `indent_level` relative to the minimum level in the result set.

### Commands

| Command | Function |
|---------|----------|
| `gs list [--list <name>] [--status complete\|incomplete]` | `cmd-list` — fetches and displays tasks (default incomplete), indented |
| `gs today` | `cmd-today` — what's actionable now; client-side reimplementation of the "My today" smart list (see below) |
| `gs lists` | `cmd-lists` — prints names of lists with `list_type` `list` or `inbox` (filters out smart/folder types) |
| `gs add <title> [--due YYYY-MM-DD] [--list <name>] [--notes <text>] [--label <name>]` | `cmd-add` — creates a task; title is all positional args joined by spaces |
| `gs done <query>` | `cmd-done` — fuzzy-matches title → marks complete |
| `gs delete <query>` | `cmd-delete` — fuzzy-matches title → deletes |
| (anything else / no args) | `cmd-help` — prints usage |

Dispatch is a `case` on the first arg at the bottom of the script. Add new commands there and in `cmd-help`.

### "My today" emulation

Smart lists can't be queried (`GET /tasks?list_id=<smart id>` returns an empty list), but `GET /lists` exposes each one's `smart_list_query`. "My today" is `!is:uncleared & (label:wip | due<=today | has:start & start<=today)`. `today-task?` hard-codes that logic (it does not parse queries): incomplete tasks that carry the `wip` label, are due today or overdue, or whose start date has been reached. Sorted by due date; the app's label grouping is not reproduced. If the query is edited in the app, update `today-task?` in both `gs` and `gs-mcp` (MCP tool: `today_tasks`).

Dates: `timeless_*` fields are date-only strings; `due_at`/`starts_at` are UTC timestamps converted to the local zone by `local-date`. Labels come from `GET /labels` (also usable for name→id resolution, which `--label` doesn't do yet). Tasks also carry `timeless_starts_at`/`starts_at` and snooze fields; the API returns future-start and snoozed tasks, so `gs list` shows them.

### Argument parsing

`parse-flags` treats every `--key` as taking the next arg as its value (no boolean flags, no `--key=value`); everything else is positional. Only `cmd-list` and `cmd-add` use it; `done`/`delete` join all args into the query.

### Output format

`format-task` prints `[<first 5 chars of id>] <title> (due: <due>) [<list name>]`; the list suffix is omitted for the Inbox. `gs list` indents 2 spaces per `indent_level` above the minimum in the result set.

### Fuzzy match behaviour

`fuzzy-match` uses `str/includes?` on lowercased titles, searching only incomplete tasks (`fetch-tasks` default). 0 matches → "No tasks matching" and exit 1. 2+ matches → print all candidates + "Multiple matches — be more specific" → exit 1.

### List name resolution

`resolve-list-id` tries exact match first, then case-insensitive. Used by `--list` flag in `gs list` and `gs add`. An unknown name prints "Error: list '<name>' not found" and exits 1.
