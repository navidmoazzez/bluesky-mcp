# Reading

Feeds come back as tagged text, not JSON. `posted_at` is ISO-8601 UTC. `cursor` on the root element continues the listing. See the `bluesky://output-format` resource for the full shape.

`since_hours` on `get_timeline` and `get_author_feed` reads a time window instead of a count. Use it for "what happened today".

`filter: "posts_no_replies"` on `get_author_feed` when studying how someone writes, so replies do not dominate the sample.

Judge engagement relative to follower count, not in absolute likes. Bluesky reports quotes separately from reposts; a post quoted more than it is reposted is usually one people disagreed with.

## Searching

`search_posts` takes operators inside `q`: `from:handle`, `to:handle`, `mentions:handle`, `domain:example.com`, `since:YYYY-MM-DD`, `until:YYYY-MM-DD`, `lang:en`, and `"quoted phrases"`. Use them rather than filtering a broad result set yourself.

It requires a connected account. A 403 here means no credentials, not a bad query.

## What this reaches that the app does not

Reach for these rather than improvising the same thing from several calls.

**`get_timeline` and `get_author_feed` take `since_hours`.** A time window, not a
fixed count. "What happened while I was asleep" is one call, not a guess at how
many posts nine hours holds.

**`get_profile` takes up to 25 accounts at once**, and `get_relationships` up to
30. Checking a list is one call. Do not loop a profile read per handle.

**`get_relationships` answers both directions.** Whether you follow them and
whether they follow back, together. Use it before a bulk follow or unfollow.

**`get_quotes` separates quotes from reposts.** The app blends them, so a quote
count is otherwise guesswork.

**`create_thread` checks every part against the 300-character limit before it
posts anything**, so a thread cannot half-publish because part four was too long.

**Most reads need no credentials at all.** Profiles, other people's posts,
threads, custom feeds and trends work unauthenticated. `search_posts` is the one
exception.
