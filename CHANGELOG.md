# Bluesky MCP Server & CLI changelog

| Component | Version | Last Updated |
|-----------|---------|--------------|
| bluesky-mcp-cli | 1.1.0 | 2026-09-01 |

---

## 1.1.0

A CLI, and a rename to match.

### Every tool is now a shell command

`src/cli.ts` is the mirror of `register()` in `tools/kit.ts`. Both adapters read
the same `ALL_TOOLS` array and call the same handlers through the same
`WriteGuard`, so `--confirm`, `BLUESKY_READ_ONLY`, `BLUESKY_ALLOW_DESTRUCTIVE`
and the audit log behave identically on both surfaces, and the two cannot drift.

The command is the tool name: `create_post` runs as `create-post`, and the
underscore spelling works too. Flags, placeholders, help text and validation all
come from the Zod schema each tool already declares, so a tool added tomorrow is
a command tomorrow with no further work.

### Two binaries

`bluesky-mcp` is the server, which must stay silent on stdout. `bluesky-cli`
lists the commands when run bare. One entry point dispatches on the invoked
name, and help output names the binary you actually typed.

### Renamed to bluesky-mcp-cli

So the name says both surfaces. The npm scope is unchanged and the server binary
is still `bluesky-mcp`, so existing client configs that run it by name keep
working.

### Known gap

Read handlers return the tagged text, so `--json` gives that text as a JSON
string rather than fields to filter on. Writes and the account commands return
real objects. The fix is for read handlers to return data and render at the edge.

21 new tests, including parity assertions that every tool routes as a command
and every schema key becomes a flag. 82 total.

---

## 1.0.0

First release. TypeScript, 41 tools, 61 tests.

### Posting

Facets are built for links, hashtags and mentions, with each mention resolved to
a DID before publishing. Bluesky renders nothing on its own: post the raw string
and every link and mention is inert grey text, with no error to notice. The
detection regexes are taken from `@atproto/api`'s `detectFacets`, unchanged apart
from a named capture group read by index instead so the file compiles at ES2017.

A reply names the thread's root, not just its parent. Naming only the parent
produces a post Bluesky accepts and then never lists in the thread it belongs to.

Images carry alt text and a measured aspect ratio, so a tall screenshot is not
letterboxed. Video goes through the transcoding service: `getUploadLimits`, a
service-auth token scoped to it, `uploadVideo`, then polling `getJobStatus`. A
plain `uploadBlob` publishes cleanly and then plays for nobody.

`create_thread` validates every part before posting any of them, so a thread
never half-publishes because part four was too long.

### The character limit

300 *graphemes* and 3,000 *bytes*, checked separately. `z.string().max(300)`
counts UTF-16 code units, so it rejects a legal post: one family emoji is one
character to Bluesky and eleven to JavaScript.

### Output

Feeds, threads and search results come back as tagged text rather than raw API
JSON. Measured on a 50-post feed: 49,839 characters against 521,426, roughly
12,500 tokens instead of 130,000. One renderer, every attribute escaped, ISO-8601
UTC timestamps so two can be compared, a repost wrapping the original rather than
flattening it, placeholders for deleted and blocked posts, and moderation labels
surfaced.

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

Sessions cached per account and refreshed with `com.atproto.server.refreshSession`
rather than re-minted, because `createSession` is rate limited hard and an access
JWT lasts about two hours. 429 and 5xx retried with jittered backoff honouring
`ratelimit-reset`. Per-request timeout, and a minimum interval between requests so
a paginating tool stays polite. Reads that need no session go to the public
appview, so the server is useful before it is configured.

### Shared with HQ

`src/` is shared verbatim with the Bluesky connector in Navid Media's HQ app,
except `config.ts`, where credentials come from a connector row rather than the
environment. A fix to facets, the output format or a changed endpoint lands in
both rather than being made twice and drifting.
