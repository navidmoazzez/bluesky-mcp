/**
 * Analytics.
 *
 * Bluesky publishes no analytics API, which is why every third-party dashboard
 * builds its own. It does not need one: `likeCount`, `repostCount`,
 * `replyCount` and `quoteCount` ride along on every post the API already
 * returns, and `followersCount` on every profile. Everything here is arithmetic
 * over one `getAuthorFeed` call.
 *
 * What genuinely cannot be computed from a single call is growth over time.
 * A follower count is a snapshot, and a snapshot cannot tell you a trend, so
 * there is deliberately no `follower_growth` tool pretending otherwise.
 */

import { z } from "zod";
import { cleanActor, resolvePostUri } from "../api/identity.js";
import { accountArg, clamp, defineTool, paginate, type AnyToolSpec } from "./kit.js";

type FeedItem = Record<string, any>;

/** The four numbers Bluesky exposes, plus the total everyone ranks on. */
type Counts = { likes: number; reposts: number; replies: number; quotes: number; total: number };

function countsOf(post: Record<string, any>): Counts {
  const likes = post?.likeCount ?? 0;
  const reposts = post?.repostCount ?? 0;
  const replies = post?.replyCount ?? 0;
  const quotes = post?.quoteCount ?? 0;
  return { likes, reposts, replies, quotes, total: likes + reposts + replies + quotes };
}

/**
 * What kind of post it is, because "images beat text for me" is the question
 * behind most content-performance reports.
 */
function formatOf(post: Record<string, any>): string {
  const t = post?.embed?.$type ?? post?.record?.embed?.$type ?? "";
  if (t.includes("video")) return "video";
  if (t.includes("images")) return "image";
  if (t.includes("external")) return "link";
  if (t.includes("record")) return "quote";
  return "text";
}

function isOwnPost(item: FeedItem, did: string): boolean {
  // A repost of someone else appears in your feed and is not your content.
  if (item?.reason?.$type?.includes("reasonRepost")) return false;
  return item?.post?.author?.did === did;
}

/** One `getAuthorFeed` walk, shared by every tool here. */
async function ownPosts(
  ctx: Parameters<Parameters<typeof defineTool>[0]["handler"]>[1],
  actor: string | undefined,
  account: string | undefined,
  limit: number | undefined,
  days: number | undefined,
): Promise<{ handle: string; did: string; followers: number; posts: FeedItem[]; days?: number }> {
  // Public appview when nothing is configured, so studying any account works
  // before credentials exist, exactly as the reading tools do.
  const signedIn = ctx.client.accounts.length > 0;
  const chosen = signedIn ? ctx.account(account) : undefined;
  const who = actor ? cleanActor(actor) : chosen?.handle;
  if (!who) {
    throw new Error(
      "No account configured, so there is no default to report on. Pass actor, or set BLUESKY_IDENTIFIER and BLUESKY_APP_PASSWORD.",
    );
  }

  const profile = signedIn
    ? await ctx.client.call<{ did: string; handle: string; followersCount?: number }>(
        chosen!,
        "app.bsky.actor.getProfile",
        { query: { actor: who } },
      )
    : await ctx.client.publicCall<{ did: string; handle: string; followersCount?: number }>(
        "app.bsky.actor.getProfile",
        { actor: who },
      );

  const max = clamp(limit, 100, 500);
  const cutoff = days ? Date.now() - days * 86_400_000 : undefined;

  const walked = await paginate<FeedItem>(
    async (next, size) => {
      const params = { actor: profile.did, limit: size, cursor: next, filter: "posts_no_replies" };
      const data = signedIn
        ? await ctx.client.call<{ feed?: FeedItem[]; cursor?: string }>(
            chosen!,
            "app.bsky.feed.getAuthorFeed",
            { query: params },
          )
        : await ctx.client.publicCall<{ feed?: FeedItem[]; cursor?: string }>(
            "app.bsky.feed.getAuthorFeed",
            params,
          );
      return { items: data.feed ?? [], cursor: data.cursor };
    },
    max,
    cutoff
      ? {
          stop: (item: FeedItem) => {
            const at = Date.parse(item?.post?.record?.createdAt ?? item?.post?.indexedAt ?? "");
            return Number.isFinite(at) && at < cutoff;
          },
        }
      : {},
  );

  const posts = walked.items.filter((i) => isOwnPost(i, profile.did));
  return { handle: profile.handle, did: profile.did, followers: profile.followersCount ?? 0, posts, days };
}

/** Engagement rate against followers, the number every dashboard leads with. */
function rate(total: number, posts: number, followers: number): number | null {
  if (!followers || !posts) return null;
  return Math.round((total / posts / followers) * 10_000) / 100;
}

const rankPosts = defineTool({
  name: "rank_posts",
  title: "Rank posts by engagement",
  description:
    "Your posts, best first, with likes, reposts, replies and quotes for each. Bluesky shows you none of this. Use days to score a period rather than a fixed count, and format to compare text against images and video.",
  schema: {
    actor: z.string().optional().describe("Whose posts. Defaults to the connected account. Works on anyone public."),
    days: z.number().min(1).max(365).optional().describe("Only posts from the last N days."),
    limit: z.number().int().min(1).max(500).optional().describe("How many posts to score. Default 100."),
    top: z.number().int().min(1).max(100).optional().describe("How many to return. Default 10."),
    ...accountArg,
  },
  risk: "read",
  handler: async ({ actor, days, limit, top, account }, ctx) => {
    const { handle, followers, posts } = await ownPosts(ctx, actor, account, limit, days);

    const scored = posts
      .map((i) => {
        const p = i.post;
        const c = countsOf(p);
        return {
          uri: p?.uri,
          url: `https://bsky.app/profile/${p?.author?.handle}/post/${String(p?.uri).split("/").pop()}`,
          posted_at: p?.record?.createdAt ?? p?.indexedAt,
          format: formatOf(p),
          text: String(p?.record?.text ?? "").slice(0, 140),
          ...c,
        };
      })
      .sort((a, b) => b.total - a.total);

    const engagement = scored.reduce((n, p) => n + p.total, 0);
    return {
      account: handle,
      followers,
      scored: scored.length,
      window_days: days ?? null,
      engagement_rate_percent: rate(engagement, scored.length, followers),
      posts: scored.slice(0, clamp(top, 10, 100)),
    };
  },
});

const getPostStats = defineTool({
  name: "get_post_stats",
  title: "Engagement on one post",
  description:
    "Likes, reposts, replies and quotes for a single post, by URL or at:// URI. The one-post version of rank_posts.",
  schema: {
    uri: z.string().describe("A bsky.app link or an at:// URI."),
    ...accountArg,
  },
  risk: "read",
  handler: async ({ uri, account }, ctx) => {
    const at = await resolvePostUri(ctx.client, uri);
    const data = ctx.client.accounts.length
      ? await ctx.client.call<{ posts?: Record<string, any>[] }>(
          ctx.account(account),
          "app.bsky.feed.getPosts",
          { query: { uris: at } },
        )
      : await ctx.client.publicCall<{ posts?: Record<string, any>[] }>("app.bsky.feed.getPosts", { uris: at });
    const post = data.posts?.[0];
    // Thrown, not returned: a returned error object exits 0, and a script
    // cannot tell "no such post" from "a post with no engagement".
    if (!post) throw Object.assign(new Error(`No post found for ${uri}.`), { status: 404 });
    return {
      uri: post.uri,
      author: post.author?.handle,
      posted_at: post.record?.createdAt ?? post.indexedAt,
      format: formatOf(post),
      text: String(post.record?.text ?? "").slice(0, 300),
      ...countsOf(post),
    };
  },
});

const getEngagementSummary = defineTool({
  name: "get_engagement_summary",
  title: "Engagement summary",
  description:
    "Totals, averages and engagement rate across recent posts, broken down by format so you can see whether images or video actually earn their effort. Bluesky offers no equivalent.",
  schema: {
    actor: z.string().optional().describe("Whose posts. Defaults to the connected account."),
    days: z.number().min(1).max(365).optional().describe("Only posts from the last N days. Default 30."),
    limit: z.number().int().min(1).max(500).optional().describe("Maximum posts to read. Default 200."),
    ...accountArg,
  },
  risk: "read",
  handler: async ({ actor, days, limit, account }, ctx) => {
    const window = days ?? 30;
    const { handle, followers, posts } = await ownPosts(ctx, actor, account, limit ?? 200, window);

    const totals = { likes: 0, reposts: 0, replies: 0, quotes: 0, total: 0 };
    const byFormat: Record<string, { posts: number; engagement: number }> = {};

    for (const item of posts) {
      const c = countsOf(item.post);
      totals.likes += c.likes;
      totals.reposts += c.reposts;
      totals.replies += c.replies;
      totals.quotes += c.quotes;
      totals.total += c.total;
      const f = formatOf(item.post);
      (byFormat[f] ??= { posts: 0, engagement: 0 }).posts += 1;
      byFormat[f].engagement += c.total;
    }

    const n = posts.length;
    const per = (v: number) => (n ? Math.round((v / n) * 10) / 10 : 0);

    return {
      account: handle,
      followers,
      window_days: window,
      posts: n,
      totals,
      per_post: {
        likes: per(totals.likes),
        reposts: per(totals.reposts),
        replies: per(totals.replies),
        quotes: per(totals.quotes),
        engagement: per(totals.total),
      },
      engagement_rate_percent: rate(totals.total, n, followers),
      by_format: Object.fromEntries(
        Object.entries(byFormat)
          .map(([f, v]) => [f, { posts: v.posts, engagement: v.engagement, per_post: Math.round((v.engagement / v.posts) * 10) / 10 }])
          .sort((a, b) => (b[1] as any).per_post - (a[1] as any).per_post),
      ),
    };
  },
});

const getPostingPatterns = defineTool({
  name: "get_posting_patterns",
  title: "When your posts do best",
  description:
    "Your posting times crossed with the engagement they earned, by hour and by weekday, so 'when should I post' is answered from your own account rather than a generic chart.",
  schema: {
    actor: z.string().optional().describe("Whose posts. Defaults to the connected account."),
    days: z.number().min(1).max(365).optional().describe("Only posts from the last N days. Default 90."),
    limit: z.number().int().min(1).max(500).optional().describe("Maximum posts to read. Default 300."),
    timezone_offset_hours: z
      .number()
      .min(-14)
      .max(14)
      .optional()
      .describe("Shift timestamps from UTC to your local hours, e.g. 2 for CEST."),
    ...accountArg,
  },
  risk: "read",
  handler: async ({ actor, days, limit, timezone_offset_hours, account }, ctx) => {
    const window = days ?? 90;
    const offset = (timezone_offset_hours ?? 0) * 3_600_000;
    const { handle, posts } = await ownPosts(ctx, actor, account, limit ?? 300, window);

    const hours: Record<number, { posts: number; engagement: number }> = {};
    const weekdays: Record<string, { posts: number; engagement: number }> = {};
    const NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

    for (const item of posts) {
      const at = Date.parse(item?.post?.record?.createdAt ?? item?.post?.indexedAt ?? "");
      if (!Number.isFinite(at)) continue;
      const local = new Date(at + offset);
      const c = countsOf(item.post);
      const h = local.getUTCHours();
      const d = NAMES[local.getUTCDay()] as string;
      (hours[h] ??= { posts: 0, engagement: 0 }).posts += 1;
      hours[h]!.engagement += c.total;
      (weekdays[d] ??= { posts: 0, engagement: 0 }).posts += 1;
      weekdays[d]!.engagement += c.total;
    }

    const shape = (rec: Record<string | number, { posts: number; engagement: number }>) =>
      Object.entries(rec)
        .map(([k, v]) => ({ key: k, posts: v.posts, engagement: v.engagement, per_post: Math.round((v.engagement / v.posts) * 10) / 10 }))
        .sort((a, b) => b.per_post - a.per_post);

    const byHour = shape(hours);
    const byWeekday = shape(weekdays);

    return {
      account: handle,
      window_days: window,
      posts: posts.length,
      timezone_offset_hours: timezone_offset_hours ?? 0,
      // Thin samples rank high on luck, so say how many posts each bucket holds.
      best_hours: byHour.slice(0, 5),
      best_weekdays: byWeekday.slice(0, 3),
      by_hour: byHour.sort((a, b) => Number(a.key) - Number(b.key)),
      by_weekday: byWeekday,
    };
  },
});

export const analyticsTools: AnyToolSpec[] = [
  rankPosts,
  getPostStats,
  getEngagementSummary,
  getPostingPatterns,
] as AnyToolSpec[];
