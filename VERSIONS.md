# Bluesky MCP Versions

| Component | Version | Last Updated |
|-----------|---------|--------------|
| bluesky-mcp | 1.0.0 | 2026-08-31 |

---

## 1.0.0

First release. TypeScript, 41 tools, 61 tests.

Written after reading both existing Bluesky MCP servers in full from source.
The audit is in [docs/reference-audit.md](docs/reference-audit.md) and carries
a file and line reference for every claim.

### The things that were wrong elsewhere

**Facets.** `brianellin/bsky-mcp-server` sends `{text, createdAt}` and nothing
else, so every link and every mention it publishes is inert grey text.
`berlinbra/bluesky-mcp` cannot post at all. This server builds facets for links,
hashtags and mentions, resolving each mention to a DID first. The detection
regexes are taken from `@atproto/api`'s `detectFacets`, unchanged apart from a
named capture group read by index instead so the file compiles at ES2017.

**Thread roots.** A reply must name the thread's root, not its parent. The
reference sets both to the parent, which produces a reply Bluesky accepts and
then never lists in the thread it belongs to.

**Video.** `com.atproto.repo.uploadBlob` accepts a video and returns 200, and
the resulting post plays for nobody because nothing transcoded it. The real
path is `getUploadLimits`, then a service-auth token scoped to the video
service, then `uploadVideo`, then polling `getJobStatus`. Neither reference
implements video at all.

**Grapheme counting.** The 300-character limit is 300 *graphemes* and 3,000
*bytes*. `z.string().max(300)` counts UTF-16 code units, so it rejects a legal
post: one family emoji is one character to Bluesky and eleven to JavaScript.
Both limits are checked separately.

**Escaping.** The reference format escapes attributes in two of its three
rendering paths. Ours has one renderer and escapes everything.

**Timestamps.** `toLocaleString()` renders in the host's locale, so the same
post reads differently on two machines. Ours is ISO-8601 UTC throughout.

**Sessions.** `berlinbra` constructs a client and logs in on every tool call.
`brianellin` logs in once at startup and never refreshes, so it stops working
after about two hours. Ours caches per account and refreshes.

### The thing that was right elsewhere

`bsky-mcp-server`'s structured XML output. Measured on a 50-post feed: 49,839
characters against 521,426 for the raw JSON a naive server returns — roughly
12,500 tokens instead of 130,000. The idea and the broad tag shape are taken
wholesale, with the fixes above plus `recordWithMedia` support, placeholders for
deleted and blocked posts, moderation labels, cursors on the root element, and
a feed that stays in the order the server sent it.

### Tools

41, against 19 and 8.

New relative to both references: `create_thread`, `delete_post`,
`unlike_post`, `unrepost`, `unfollow`, `mute_account`, `unmute_account`,
`block_account`, `unblock_account`, `set_reply_permissions`, `get_quotes`,
`get_reposted_by`, `get_relationships`, `get_lists`, `get_list_members`,
`get_notifications`, `get_unread_count`, `mark_notifications_seen`,
`get_suggested_follows`, `list_accounts`, `whoami`, `get_video_job_status`.

Every action has its inverse. Neither reference could undo anything.

### Safety

`create_post`, `create_thread`, `delete_post` and `block_account` need
`confirm: true`. `BLUESKY_READ_ONLY=1` removes every write from the tool list.
`BLUESKY_ALLOW_DESTRUCTIVE=0` keeps likes and follows but blocks posting and
deleting. `BLUESKY_AUDIT_LOG` records every attempted write. Every tool carries
MCP annotations. Neither reference guards anything.

### Multi-account

`BLUESKY_ACCOUNTS` takes a JSON array, and every tool that acts as someone takes
an optional `account`. `BLUESKY_DEFAULT_ACCOUNT` decides which acts when none is
named, with exact handle matches beating prefix matches so two similar handles
cannot be confused.

### Reliability

Sessions cached and refreshed. 429 and 5xx retried with jittered backoff
honouring `ratelimit-reset`. Per-request timeout. A minimum interval between
requests so a paginating tool stays polite. Reads that need no session go to the
public appview, so the server is useful before it is configured.

### Shared with HQ

`src/` is shared verbatim with the Bluesky connector in Navid Media's HQ app,
except `config.ts`, where credentials come from a connector row rather than the
environment. A fix to facets, the output format or a changed endpoint lands in
both rather than being made twice and drifting.
