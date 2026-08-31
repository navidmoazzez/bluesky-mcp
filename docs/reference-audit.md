# Audit of the two existing Bluesky MCP servers

Read from source on 2026-08-31, not from the READMEs and not from memory.
Every API claim below was also checked against the live endpoint or the
published lexicon on the same day; those checks are quoted where they matter.

- `brianellin/bsky-mcp-server` — TypeScript, 19 tools, 2,529 lines across `src/`
- `berlinbra/bluesky-mcp` — Python, 8 tools, 288 lines in `src/bluesky_mcp/server.py`

This file exists so the reasons behind our design decisions do not get lost.
Every claim carries a file and line reference.

## Why this project exists

Not because either is bad. `bsky-mcp-server` contains the single best idea in
this problem space, and we took it wholesale. The gap is that one of them can
read Bluesky well and cannot write to it at all, the other can barely do
either, and neither can undo anything it does.

## Their structure

```
brianellin/bsky-mcp-server
  src/index.ts              1,467   all 19 tools inline
  src/llm-preprocessor.ts     752   the XML output format
  src/resources.ts            287   platform-info and post-schema resources
  src/utils.ts                277   handles, URLs, escaping
  src/prompts.ts               46   one prompt
  POST_FORMAT_SPEC.md         264   the format, documented
  test/                             fixtures plus two ad-hoc scripts

berlinbra/bluesky-mcp
  src/bluesky_mcp/server.py   288   all 8 tools, list + dispatch
  src/bluesky_mcp/__init__.py
```

## The best idea: structured output

`llm-preprocessor.ts` renders posts as tagged text instead of API JSON, and
`POST_FORMAT_SPEC.md` documents the shape. This is the correct answer and it is
not a small win.

Measured on a real 50-post author feed (`app.bsky.feed.getAuthorFeed`,
`actor=bsky.app`, `limit=50`, fetched 2026-08-31):

| Output | Characters | ≈ tokens |
|---|---:|---:|
| Raw JSON, as `berlinbra` returns it (`indent=2`) | 521,426 | ~130,000 |
| Raw JSON, compact | 330,919 | ~83,000 |
| Tagged format (ours) | 49,839 | ~12,500 |

Ten times smaller than what a raw-JSON server returns, and the text is where a
model expects to find it rather than buried under CIDs, blob refs, viewer state
and label arrays. We adopted the idea and the broad shape of the tags. What we
changed is below.

## brianellin/bsky-mcp-server

### It cannot post a working link or mention

`grep -n facets src/index.ts` returns nothing. `create-post` (index.ts:212)
sends `{text, createdAt}` and nothing else.

Bluesky renders nothing on its own. A URL in post text is grey, unclickable
text unless a **facet** — a byte range attached to the record — marks it. An
`@handle` is likewise inert unless a facet carries the mentioned account's DID.

So every post this server publishes that contains a link or a mention looks
broken to everyone who reads it, and there is no error to notice. It is the
single most consequential gap in either repository.

Ours builds facets for links, hashtags and mentions, resolving each mention to
a DID before publishing (`src/content/facets.ts`). The detection regexes are
copied verbatim from `@atproto/api`'s `detectFacets` so a post written here
segments exactly the way the official client would segment it.

### Replies detach from their thread

```ts
// src/index.ts:249-251
record.reply = {
  parent: { uri: replyTo, cid: parentCid },
  root:   { uri: replyTo, cid: parentCid }
}
```

A reply must name the thread's **root**, not its immediate parent. Setting root
to the parent produces a post that Bluesky accepts, shows as a reply to one
post, and never lists in the thread it belongs to. Replying to the third post
in a thread silently starts a new one.

Ours reads the parent's own `reply.root` and reuses it, falling back to the
parent only when the parent really is the root (`src/tools/posts.ts`,
`replyRefs`).

### Half of the output is unescaped

`escapeXml` is imported once and used in the two thread-rendering paths
(llm-preprocessor.ts:465 and :634 onward). The feed-rendering path — `formatPost` (line 100) and
`formatEmbeds` (line 184), which is what `get-timeline-posts`, `search-posts`,
`get-liked-posts`, `get-user-posts` and `get-feed-posts` all call — uses it
nowhere.

An author whose display name contains a `"` therefore emits malformed XML from
the feed renderer and valid XML from the thread renderer. Post text is never
escaped in any path, so a post containing `</post>` closes the element early.

This is a direct consequence of the file having three near-identical copies of
the same rendering logic (`formatPost`, `processThreadViewPostChain`,
`processThreadViewPost`), which have already drifted apart in other ways too —
the feed path omits link thumbnails, the thread paths include them.

Ours has one renderer, `renderPost`, and every attribute and every text body
goes through `escapeXml` (`src/format/posts.ts`). There is a test for the
display-name case.

### Timestamps are not comparable

`new Date(...).toLocaleString()` at llm-preprocessor.ts:467, :636 and :661, and
`formatISO9075` at :50. Both render in the server's own locale and timezone, so
the same post reads differently on two machines and a model cannot order two
posts by their printed timestamps.

Ours emits ISO-8601 UTC everywhere, and passes an unparseable value through
unchanged rather than printing `Invalid Date`.

### `get-post-thread` rejects valid posts

```ts
// src/index.ts:362
if (!uri.startsWith('at://did:plc:') || !uri.includes('/app.bsky.feed.post/')) {
```

`did:plc:` is one of two DID methods in use. Every post on a self-hosted PDS
using `did:web:` — which is exactly the audience most likely to run an MCP
server — is unreachable through this tool. A `bsky.app` link is also rejected,
which is why the repo ships a separate `convert-url-to-uri` tool whose only job
is to work around this.

Ours accepts an `at://` URI, a `bsky.app` link or a bare record key on every
URI argument (`src/api/identity.ts`), so no conversion tool is needed.

### Trending output is broken against the current API

```ts
// src/index.ts:615-617
const startTime = new Date(topic.startTime).toLocaleString();
...
Post Count: ${topic.postCount} posts
```

`app.bsky.unspecced.getTrendingTopics` returns
`{topic, displayName, description, link}` today. Verified live on 2026-08-31 —
neither `postCount` nor `startTime` is present. Every trending topic this tool
returns is annotated `Post Count: undefined posts` and
`Started Trending: Invalid Date`.

Ours reads the current shape and surfaces the `description` field, which is the
one genuinely useful field and did not exist when the reference was written.

### `recordWithMedia` is dropped

`grep -c recordWithMedia src/llm-preprocessor.ts` returns 0. A quote post with
an image attached — extremely common — renders with neither the quote nor the
image. Ours renders both.

### Nothing can be undone

19 tools, of which `like-post`, `follow-user` and `create-post` are the writes.
There is no unlike, no unfollow, no unrepost, no delete, no mute, no block.
An agent that can only add to your graph is an agent you cannot leave alone
with it. Ours has the inverse of every action.

### Writes are unguarded

`create-post`, `like-post` and `follow-user` run on the first call with no
confirmation. A post is public the instant it lands and there is no unsend.

### Other, smaller

- **Indentation is injected into post text.** Replies are rendered and then
  indented line by line (llm-preprocessor.ts, `formatReplies`), which also
  indents the continuation lines *inside* `<content>`. A two-paragraph post
  three levels deep comes back with leading spaces its author never typed.
  Ours passes depth down and renders each post at its final position once.
- **The feed is reordered.** `groupThreads` + `formatThread` nest replies under
  their roots, which destroys the reverse-chronological order that is the whole
  point of a timeline. Ours keeps the feed flat and carries the relationship in
  `reply_to` and `thread_root` attributes instead.
- **A pinned post is not a repost.** Not applicable to their tool set, but the
  same shape caught us: `app.bsky.feed.defs#reasonPin` and `#reasonRepost` both
  arrive as `reason`, and treating every reason as a repost wraps an account's
  own pinned post in an author-less `<repost>`.
- One process-wide login at startup, no refresh. An access JWT lasts about two
  hours; `initializeBlueskyConnection` (index.ts:41) never calls
  `refreshSession` — `grep -c refreshSession src/index.ts` returns 0, so a long-lived server stops working and only a restart
  fixes it.
- `console.error` is used for logging and for debug output in the preprocessor,
  which on a stdio transport shares the channel with the protocol's own stderr
  diagnostics.

### What it does that we kept

- The XML output format, and the decision to document it in a spec file.
- Resources describing the platform, so a model knows what a DID and a facet
  are before it asks.
- A prompt, so the workflow the server is good at is one click.
- `get-timeline-posts` taking hours instead of a count. We generalised it to a
  `since_hours` argument on both the timeline and author-feed tools.
- Auto-pagination past the 100-item ceiling.
- `search-feeds` and `get-pinned-feeds`, which are the way into custom feeds and
  are absent from most Bluesky integrations.

## berlinbra/bluesky-mcp

### It returns raw JSON

```py
# server.py:284
return [types.TextContent(type="text", text=json.dumps(response.model_dump(), indent=2))]
```

Every one of the eight tools ends here. See the table above: a 50-post feed is
roughly 130,000 tokens this way. There is no formatting layer at all.

### It logs in again on every single tool call

```py
# server.py:193-194
bluesky = BlueSkyClient()
await bluesky.ensure_client()
```

`BlueSkyClient` is constructed fresh inside `handle_call_tool`, so its
`self.client` is always `None` and `ensure_client` always calls `login`.
`com.atproto.server.createSession` is one of the more tightly rate-limited
endpoints on Bluesky. A session lasts about two hours and has a refresh token
good for months; this uses neither.

Ours caches a session per account, refreshes it with
`com.atproto.server.refreshSession` when the access JWT expires, and only falls
back to a full login if the refresh fails (`src/api/client.ts`).

### `bluesky_get_liked_posts` cannot work

```py
# server.py:242-244
bluesky.client.app.bsky.feed.get_likes,
{'uri': IDENTIFIER, 'limit': limit, 'cursor': cursor}
```

`app.bsky.feed.getLikes` takes the AT URI of **a post** and returns who liked
it. `IDENTIFIER` is a handle. Verified live:

```
GET /xrpc/app.bsky.feed.getLikes?uri=bsky.app
{"error":"InvalidRequest","message":"Invalid app.bsky.feed.getLikes params: Invalid at-uri (got \"bsky.app\")"}
```

The tool errors on every call. The endpoint it wants is
`app.bsky.feed.getActorLikes`. Ours has both, as `get_post_likes` and
`get_liked_posts`.

### `bluesky_search_profiles` uses a deprecated parameter

`{'term': query}` at server.py:262. The lexicon marks `term` as
`"DEPRECATED: use 'q' instead"`. It still answers 200 today, so this works —
but it is on the list of things that stop working without notice.

### It cannot write anything

Eight tools, all reads. No posting, no replying, no liking, no following.
The README presents this as the tool set rather than as a limitation.

### It always acts as one account

Every tool hardcodes `IDENTIFIER` as the actor: `bluesky_get_profile`,
`bluesky_get_posts`, `bluesky_get_follows` and `bluesky_get_followers` can only
ever describe you. You cannot look up anyone else's profile or followers, which
is most of what someone wants a Bluesky tool for.

### Credential validation is commented out

```py
# server.py:14-15
# if not API_KEY or not IDENTIFIER:
#     raise ValueError("BLUESKY_APP_PASSWORD and BLUESKY_IDENTIFIER must be set")
```

With no environment set, the server starts and every tool fails inside
`login()` with whatever the SDK raises.

## What neither of them has

Checked against both source trees:

| | brianellin | berlinbra | ours |
|---|:---:|:---:|:---:|
| Facets on write (links, tags, mentions) | – | – | ✅ |
| Correct thread root on a reply | ✗ | – | ✅ |
| Images with alt text | – | – | ✅ |
| Measured aspect ratios on images | – | – | ✅ |
| Video, through the transcode service | – | – | ✅ |
| Link cards | – | – | ✅ |
| Quote posts | – | – | ✅ |
| Threads posted as a unit | – | – | ✅ |
| Delete a post | – | – | ✅ |
| Unlike / unrepost / unfollow / unblock | – | – | ✅ |
| Mute and block | – | – | ✅ |
| Reply controls (threadgate) | – | – | ✅ |
| Quote controls (postgate) | – | – | ✅ |
| Notifications | – | – | ✅ |
| Mark notifications read | – | – | ✅ |
| Several accounts at once | – | – | ✅ |
| Session refresh | – | – | ✅ |
| Retry with `ratelimit-reset` | – | – | ✅ |
| Grapheme-correct 300-character limit | ✗ | – | ✅ |
| Read without credentials | – | – | ✅ |
| Confirmation on public writes | – | – | ✅ |
| Read-only mode | – | – | ✅ |
| Unit tests | – | – | ✅ |

`✗` means present but wrong; `–` means absent.

The grapheme row is worth naming. `bsky-mcp-server` uses
`z.string().max(300)` (index.ts:216), which counts UTF-16 code units. `👨‍👩‍👧‍👦` is one
character to Bluesky and eleven to JavaScript, so a legal post is refused
locally and never reaches the API. Bluesky's actual limit is 300 graphemes
**and** 3,000 bytes; ours checks both, separately, with a message that names
which one was exceeded.

## Video, which nobody implements

Worth its own note because the obvious implementation looks like it works.

`com.atproto.repo.uploadBlob` accepts a video file and returns a blob. Embed
that blob and the post publishes cleanly with a 200. It then plays for nobody,
because the video was never transcoded and has no HLS playlist.

The real path, confirmed against `bluesky-social/social-app` and the live
service on 2026-08-31:

1. `app.bsky.video.getUploadLimits` on `video.bsky.app` — refuses early when
   the daily quota is spent.
2. `com.atproto.server.getServiceAuth` with `aud=did:web:video.bsky.app` and
   `lxm=app.bsky.video.uploadVideo` — the video service is not your PDS, so
   your session token is not accepted there.
3. `app.bsky.video.uploadVideo` on `video.bsky.app` — returns a **job**, not a
   blob.
4. Poll `app.bsky.video.getJobStatus` until `JOB_STATE_COMPLETED`, which is
   when the blob to embed finally exists.

`src/content/media.ts` does all four.

## Summary

`bsky-mcp-server` is a good reader with a broken writer: its structured output
is the right answer and we adopted it, and its `create-post` publishes dead
links and detached replies. `bluesky-mcp` is a thin, mostly-working wrapper
that returns raw JSON, re-authenticates on every call, and has one tool that
cannot succeed.

Neither can undo anything it does, and neither asks before doing something
public. Those two together are what made a third server worth writing rather
than a pull request worth sending.
