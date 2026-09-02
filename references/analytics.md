# Analytics

Bluesky publishes no analytics API. It does not need one for most questions:
`likeCount`, `repostCount`, `replyCount` and `quoteCount` ride along on every
post the feed already returns, and `followersCount` on every profile. Every
tool here is arithmetic over one `getAuthorFeed` call, and every one works on
any public account with no credentials at all.

| Question | Command |
|---|---|
| Which of my posts did best | `rank-posts --days 30 --top 10` |
| How did this one post do | `get-post-stats --uri <url>` |
| How am I doing overall, and do images beat text | `get-engagement-summary --days 30` |
| When should I post | `get-posting-patterns --days 90 --timezone-offset-hours 2` |

## Engagement rate

`engagement_rate_percent` is total engagement per post divided by followers.
Three to six percent is considered healthy on Bluesky. It falls as an account
grows, so it compares an account against itself over time, never against
another account of a different size.

## Reading the patterns

`best_hours` and `best_weekdays` carry a `posts` count for each bucket on
purpose. A bucket holding two posts that happened to go well ranks above a
bucket holding thirty steady ones, and that is luck rather than a finding.
Ignore any bucket with fewer than about five posts.

Times are UTC unless `--timezone-offset-hours` is passed.

## What is not here

**Follower growth.** A follower count is a snapshot, and no single call can
tell you a trend. Growth needs yesterday's number stored somewhere, which means
a scheduled collector rather than a tool call. Nothing here pretends otherwise.

**Impressions and reach.** Bluesky does not expose them to anyone. A dashboard
showing them for Bluesky is estimating.

**Bookmarks.** Not verified as publicly readable, so no tool claims to count
them.
