# Writing posts

Bodies are plain text, capped at **300 characters**. Write them the way a person types them.

**Do not format links or mentions.** `https://example.com`, `@alice.bsky.social` and `#tag` written normally become real links, real mentions and real tags. Formatting them as markdown produces a post with literal brackets in it.

**Anything over 300 characters goes to `create_thread`**, not a truncated `create_post`. It validates every part before posting any of them, so a thread never half-publishes.

**Media:** `images[]` (up to four, each with real `alt` text, each under 1MB), `video_url` (one MP4), `link` (a preview card), `quote` (an at:// URI or a bsky.app link). One embed per post, or a quote plus one piece of media.

**Replies:** pass `reply_to`. Do not try to construct the thread root yourself.

Read `get_post_thread` before replying to something, so the reply lands with context.

## Identifying a post

Every URI argument accepts an `at://` URI or a `bsky.app` link interchangeably. There is no conversion step.

Handles need their domain: `alice.bsky.social`, not `alice`. A leading `@` is fine.

## Actions that need confirmation

`create_post`, `create_thread`, `delete_post` and `block_account` refuse to run without `confirm: true`. A post is public the instant it lands and there is no unsend.

Pass `confirm` when the user has asked for that specific action. Do not pass it to get past the refusal on something you decided to do yourself. When drafting, show the draft as text and wait.

Likes, reposts, follows and mutes need no confirmation. They are one call to undo, and every one of them has its inverse (`unlike_post`, `unrepost`, `unfollow`, `unmute_account`, `unblock_account`).
