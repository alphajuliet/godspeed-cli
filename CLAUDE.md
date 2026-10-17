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

The CLI is a Babashka script (`gs`) plus a shared library (`godspeed.clj`). No build step, no dependencies to install — Babashka ships with `babashka.http-client` and `cheshire` (JSON) built in. Run unit tests with `bb test` (`test/godspeed_test.clj`).

### Shared library (`godspeed.clj`)

Holds everything common to `gs` and `gs-mcp`: TLS truststore, the `api` request function (15s timeout; non-2xx → `ex-info` "HTTP <status> from <method> <path>: <body>"), `fetch-tasks`/`fetch-lists`/`fetch-labels`, date helpers, `today-task?`, name→id resolution (`find-by-name`, `resolve-label-ids`) and `fuzzy-match`. Each script adds its own directory (symlinks resolved) to the classpath and requires it. Never print to stdout from the lib (stderr via `warn`). API fixes are now made once, here.

### MCP server (`gs-mcp`)

`gs-mcp` is a second Babashka script: a stdio MCP server for Claude Desktop (hand-rolled JSON-RPC: `initialize`, `tools/list`, `tools/call`). Tools: `list_lists` (lists plus folders, each with its `folder`, `type` and `archived`; smart lists omitted), `list_tasks`, `today_tasks`, `list_labels`, `add_task`, `complete_task`, `delete_task`. Unlike `gs`, it works by full task id, not fuzzy title. stdout is reserved for JSON-RPC; never print anything else to it. Malformed input lines get a -32700 reply and handler exceptions a -32603; the loop never dies. `list_tasks`/`today_tasks` return `task->map` objects: `labels` (names), `notes`, `due`, `start`, `created_at`, `updated_at`, `completed_at` (nil/empty fields dropped); `list_tasks` also takes `label` (filter) and `include_notes` (default true). `add_task` takes `labels` (comma-separated names) and `list_labels` lists them.

Claude Desktop config (`~/Library/Application Support/Claude/claude_desktop_config.json`):
```json
{"mcpServers": {"godspeed": {"command": "/absolute/path/to/gs-mcp", "env": {"GODSPEED_API_KEY": "..."}}}}
```
If Desktop can't find `bb`, use `"command": "/opt/homebrew/bin/bb"` with `"args": ["/absolute/path/to/gs-mcp"]`.

### API

- Base URL: `https://api.godspeedapp.com`
- Auth: `Authorization: Bearer $GODSPEED_API_KEY`
- Endpoints used: `GET /tasks`, `POST /tasks`, `PATCH /tasks/{id}`, `DELETE /tasks/{id}`, `GET /lists`, `GET /labels`
- `GET /tasks` is called with `status` (default `incomplete`) and `limit=250`; the response has no cursor/next field (keys: `success`, `tasks`, `lists`, `labels` — note it also embeds lists and labels), so results beyond 250 are not seen. `fetch-tasks` warns on stderr when exactly 250 come back (this account does hit it). `offset`/`page`/`cursor` params were being tried when the API rate-limited us ("Rate..." plain-text, non-JSON body), so pagination is unverified
- Responses may be wrapped (`{:tasks [...]}` / `{:lists [...]}`) or a bare array; `fetch-tasks`/`fetch-lists` handle both
- Key fields on tasks: `id`, `title`, `notes`, `list_id`, `indent_level`, `order_index`, `timeless_due_at`/`due_at`, `timeless_starts_at`/`starts_at`, `label_ids`, `created_at`, `updated_at`, `completed_at`, `cleared_at`
- Key fields on lists: `id`, `name`, `list_type` (`"list"`, `"inbox"`, `"smart"`, `"folder"`)
- Only `list_type: "list"` and `"inbox"` can be queried by `list_id`; smart lists and folders cannot
- Folder membership is positional, like subtasks: a list belongs to the nearest preceding `folder` with a lower `indent_level` (sorted by `order_index`); `lists-with-folders` computes this. Lists may carry `archived_at`. Names often start with an emoji (e.g. `❓ Someday/Maybe`)
- Completion is `PATCH {is_complete: true}`
- The API rate-limits aggressive probing and then returns a plain-text (non-JSON) "Rate..." body; avoid loops of rapid calls when experimenting
- Due dates: read `timeless_due_at` (date-only) or `due_at` (timed); create with `timeless_due_at`. A `due_date` field is silently ignored by the API (verified).
- Labels: `POST /tasks` accepts `label_ids` (verified). `--label` / `labels` resolve names (case-insensitive, comma-separated) via `GET /labels`; unknown names are an error. The old `label` field was silently ignored.

### TLS / corporate proxy (Zscaler)

Babashka runs on a GraalVM native image with its own bundled CA truststore and does **not** consult the macOS keychain. Behind a TLS-intercepting proxy (e.g. Deloitte's Zscaler) the server cert for `api.godspeedapp.com` is re-signed by a corporate root CA that lives in the keychain but not in bb's truststore, so every HTTPS call fails the handshake with `javax.net.ssl.SSLHandshakeException: PKIX path building failed`. `curl`/Safari work because they use the keychain; `bb` doesn't.

The shared lib builds a custom `SSLContext` to work around this (functions `read-pem-certs` / `ca-certs` / `ssl-context`, a memoized `http-client` delay injected by `api`). The truststore is sourced from:

1. `$GODSPEED_CA_BUNDLE` — path to a PEM file; if set, used exclusively. The portable escape hatch (non-macOS, or to pin a specific bundle).
2. Otherwise, on macOS only: certs exported via `security find-certificate -a -p` from `SystemRootCertificates.keychain` (the ~158 public roots) **plus** `System.keychain` (where the corporate root lives). Loading the public roots too means `gs` still works when off the proxy.

On non-macOS with no `$GODSPEED_CA_BUNDLE`, `ssl-context` returns `nil` and calls fall back to bb's default client — behaviour is unchanged there.

Gotcha: we build the truststore from these certs directly rather than augmenting bb's defaults, because sci can't resolve the `TrustManagerFactory.init((KeyStore) null)` overload — passing `nil` throws. This is why we load the full public root set from the keychain instead of merging with bb's bundled CAs.

### Task hierarchy

Tasks have no `parent_id`. Subtask relationships are encoded positionally via `order_index` (sort order) and `indent_level` (nesting depth). To display hierarchy, sort by `order_index` and indent by `indent_level` relative to the minimum level in the result set.

### Commands

| Command | Function |
|---------|----------|
| `gs list [--list <name>] [--status complete\|incomplete]` | `cmd-list` — fetches and displays tasks (default incomplete), indented |
| `gs today` | `cmd-today` — what's actionable now; client-side reimplementation of the "My today" smart list (see below) |
| `gs lists` | `cmd-lists` — prints names of lists with `list_type` `list` or `inbox` (filters out smart/folder types) |
| `gs folders` | `cmd-folders` — tree of folders (shown with a trailing `/`), lists and the inbox in app order, indented by `indent_level`; archived lists marked; smart lists omitted |
| `gs add <title> [--due YYYY-MM-DD] [--list <name>] [--notes <text>] [--label <name>[,<name>]]` | `cmd-add` — creates a task; title is all positional args joined by spaces; `--due` is validated |
| `gs done <query>` or `--id <prefix>` | `cmd-done` — fuzzy-matches title (or id prefix) → marks complete |
| `gs delete <query>` or `--id <prefix>` | `cmd-delete` — same matching via `pick-task` → deletes |
| (anything else / no args) | `cmd-help` — prints usage |

Dispatch is a `case` on the first arg at the bottom of the script. Add new commands there and in `cmd-help`.

### "My today" emulation

Smart lists can't be queried (`GET /tasks?list_id=<smart id>` returns an empty list), but `GET /lists` exposes each one's `smart_list_query`. "My today" is `!is:uncleared & (label:wip | due<=today | has:start & start<=today)`. `today-task?` hard-codes that logic (it does not parse queries): incomplete tasks that carry the `wip` label, are due today or overdue, or whose start date has been reached. Sorted by due date; the app's label grouping is not reproduced. If the query is edited in the app, update `today-task?` in `godspeed.clj` (MCP tool: `today_tasks`).

Dates: `timeless_*` fields are date-only strings; `due_at`/`starts_at` are UTC timestamps converted to the local zone by `local-date`. Labels come from `GET /labels` (used for `wip` and `--label` name→id resolution). Tasks also carry `timeless_starts_at`/`starts_at` and snooze fields; the API returns future-start and snoozed tasks, so `gs list` shows them.

### Argument parsing

`parse-flags` treats every `--key` as taking a value (`--key value` or `--key=value`; no boolean flags); a missing value is an error. Everything else is positional. Used by `list`, `add`, `done`, `delete`. Errors (including HTTP failures) are printed to stderr with exit 1 by the dispatch `try`.

### Output format

`format-task` prints `[<first 5 chars of id>] <title> (due: <due>) [<list name>]`; the list suffix is omitted for the Inbox. `gs list` indents 2 spaces per `indent_level` above the minimum in the result set.

### Fuzzy match behaviour

`fuzzy-match` uses `str/includes?` on lowercased titles, searching only incomplete tasks (`fetch-tasks` default); `pick-task` prefers a single exact (case-insensitive) title match over substring matches. 0 matches → "No tasks matching" and exit 1. 2+ matches → print all candidates + "Multiple matches — be more specific" → exit 1.

### List name resolution

`resolve-list-id` only considers lists that can hold tasks (`list`/`inbox`, not folders or smart lists) and uses `find-by-name` (also used for labels): exact match, then case-insensitive, then ignoring leading emoji/symbols when that is unambiguous (so `household` matches `🏠 Household`). Used by `--list` flag in `gs list` and `gs add`. An unknown name prints "Error: list '<name>' not found" and exits 1.

## Known limitations / open work

- **250-task cap:** no verified pagination (see API section). `done`/`delete` can miss tasks beyond the first 250; commands warn on stderr when the cap is hit. Next step: re-probe `offset`/`page`/`cursor` params slowly, or check the official API docs.
- **`gs delete` has no confirmation:** a unique match is deleted immediately (mitigated by exact-title preference and `--id`).
- **Truststore export runs on every invocation** (`security find-certificate` for ~158 certs); could be cached keyed on keychain mtime.
- **`GET /tasks` also embeds `lists` and `labels`**, so some commands could skip their separate `/lists` and `/labels` calls.
- **`today-task?` is hard-coded** and won't notice edits to the "My today" smart-list query.
- **MCP task ids are the only handle** for `complete_task`/`delete_task`; there's no title lookup by design.
