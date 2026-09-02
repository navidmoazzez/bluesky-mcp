# Bluesky MCP Server & CLI changelog

| Component | Version | Last Updated |
|-----------|---------|--------------|
| bluesky-mcp-cli | 1.1.0 | 2026-09-01 |

---

## 1.1.0

A CLI, and a rename to match.

### Every tool is now a shell command

All 41 tools run from the terminal. The command is the tool name: `create_post`
runs as `create-post`, and the underscore spelling works too. Flags, help text
and validation come from the same schema the MCP tool declares, so both surfaces
accept the same arguments and a tool added tomorrow is a command tomorrow.

`--confirm`, `BLUESKY_READ_ONLY`, `BLUESKY_ALLOW_DESTRUCTIVE` and the audit log
behave identically whichever surface you use.

### Two binaries

`bluesky-mcp` is the server your AI app runs. `bluesky-cli` is the one you type,
and run bare it lists every command. Help output names the binary you actually
typed.

### Renamed to bluesky-mcp-cli

So the name says both surfaces. The npm scope is unchanged and the server binary
is still `bluesky-mcp`, so existing client configs keep working.

### Known gap

Read commands return the tagged text, so `--json` gives that text as a JSON
string rather than fields to filter on. Writes and the account commands return
real objects you can pipe into `jq`.

21 new tests, 82 total.

---

## 1.0.0

First release. 41 tools, 61 tests.

### Posting

Links, hashtags and mentions are marked up before publishing, with each mention
resolved to an account ID. Bluesky renders nothing on its own: post the raw
string and every link and mention is inert grey text, with no error to notice.

A reply names the thread's root, not just its parent. Naming only the parent
produces a post Bluesky accepts and then never lists in the thread it belongs to.

Images carry alt text and a measured aspect ratio, so a tall screenshot is not
letterboxed. Video goes through Bluesky's transcoding service and is polled to
completion. Uploading it as a plain file publishes cleanly and then plays for
nobody.

`create_thread` validates every part before posting any of them, so a thread
never half-publishes because part four was too long.

### The character limit

300 *graphemes* and 3,000 *bytes*, checked separately, which is what Bluesky
actually enforces. Counting JavaScript string length instead rejects legal
posts: one family emoji is one character to Bluesky and eleven to JavaScript.

### Output

Feeds, threads and search results come back as tagged text rather than raw API
JSON. Measured on a 50-post feed: 49,839 characters against 521,426, roughly
12,500 tokens instead of 130,000. Timestamps are ISO-8601 UTC so two can be
compared, a repost wraps the original rather than flattening it, deleted and
blocked posts get placeholders, and moderation labels are surfaced.

### Tools

41. Every action has its inverse: `unlike_post`, `unrepost`, `unfollow`,
`unmute_account`, `unblock_account`. Plus `create_thread`, `delete_post`,
`set_reply_permissions`, `get_quotes`, `get_relationships`, `get_lists`,
`get_notifications`, `mark_notifications_seen`, `get_suggested_follows`,
`list_accounts`, `whoami`.

### Safety

`create_post`, `create_thread`, `delete_post` and `block_account` need
`confirm: true`. `BLUESKY_READ_ONLY=1` removes every write from the tool list,
leaving 26 read tools. `BLUESKY_ALLOW_DESTRUCTIVE=0` keeps likes and follows but
blocks posting and deleting. `BLUESKY_AUDIT_LOG` records every attempted write,
mode 0600. Every tool carries MCP annotations.

### Multi-account

`BLUESKY_ACCOUNTS` takes a JSON array, and every tool that acts as someone takes
an optional `account`. `BLUESKY_DEFAULT_ACCOUNT` decides which acts when none is
named, with exact handle matches beating prefix matches so two similar handles
cannot be confused.

### Reliability

Sessions are cached per account and refreshed rather than re-created, because
creating one is rate limited hard and a session lasts about two hours. Rate
limits and server errors are retried with backoff that honours the reset header.
Requests have a timeout and a minimum interval between them, so a paginating
command stays polite. Reads that need no login go to the public API, so the
server is useful before it is configured.
