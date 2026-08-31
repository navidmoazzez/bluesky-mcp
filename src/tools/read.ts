/**
 * Reading feeds.
 *
 * Every tool here can page past Bluesky's 100-item ceiling on its own, and the
 * timeline and author-feed tools can take a time window instead of a count.
 * "What happened in the last six hours" is the question people actually ask,
 * and making the model guess how many posts that is and then drive a cursor
 * loop by hand is a tool that gets abandoned after the first page.
 *
 * Reads go through the public appview when no session is needed, so these work
 * before any credentials are configured.
 */

import { z } from "zod";
import { cleanActor, resolvePostUri } from "../api/identity.js";
import { renderActors, renderFeed } from "../format/posts.js";
import { accountArg, clamp, defineTool, pageArgs, paginate, type AnyToolSpec } from "./kit.js";

type FeedItem = Record<string, any>;

const sinceArg = {
  since_hours: z
    .number()
    .min(0.1)
    .max(720)
    .optional()
    .describe(
      "Instead of a fixed count, return everything from the last N hours. Pages until it reaches that far back, up to `limit`.",
    ),
};

/** Stop-predicate for a time window, applied to a feed item's own timestamp. */
function olderThan(cutoff: number) {
  return (item: FeedItem) => {
    const created = item?.post?.record?.createdAt ?? item?.post?.indexedAt;
    if (typeof created !== "string") return false;
    const at = new Date(created).getTime();
    return Number.isFinite(at) && at < cutoff;
  };
}

const getTimeline = defineTool({
  name: "get_timeline",
  title: "Read your home timeline",
  description:
    "Your following feed, newest first. Pass since_hours to read a time window rather than a fixed number of posts. Requires a connected account.",
  schema: {
    limit: z
      .number()
      .int()
      .min(1)
      .max(500)
      .optional()
      .describe("How many posts. Pages automatically past Bluesky's 100 ceiling. Default 30."),
    ...sinceArg,
    cursor: z.string().optional().describe("Continue from a previous page."),
    ...accountArg,
  },
  risk: "read",
  handler: async ({ limit, since_hours, cursor, account }, ctx) => {
    const chosen = ctx.account(account);
    const max = clamp(limit, 30, 500);
    const cutoff = since_hours ? Date.now() - since_hours * 3_600_000 : undefined;

    const result = await paginate<FeedItem>(
      async (next, size) => {
        const data = await ctx.client.call<{ feed?: FeedItem[]; cursor?: string }>(
          chosen,
          "app.bsky.feed.getTimeline",
          { query: { limit: size, cursor: next ?? cursor } },
        );
        return { items: data.feed ?? [], cursor: data.cursor };
      },
      max,
      cutoff ? { stop: olderThan(cutoff) } : {},
    );

    return renderFeed(result.items, {
      cursor: result.cursor,
      source: "timeline",
      note: since_hours ? `Last ${since_hours}h.` : undefined,
    });
  },
});

const getAuthorFeed = defineTool({
  name: "get_author_feed",
  title: "Read an account's posts",
  description:
    "Posts by one account, newest first. Works for anyone, with or without credentials. Use filter to separate original posts from replies and reposts: 'posts_no_replies' is what you want when studying how someone writes.",
  schema: {
    actor: z.string().describe("Handle (with or without @) or DID."),
    limit: z
      .number()
      .int()
      .min(1)
      .max(500)
      .optional()
      .describe("How many posts. Pages automatically. Default 25."),
    ...sinceArg,
    filter: z
      .enum(["posts_with_replies", "posts_no_replies", "posts_with_media", "posts_and_author_threads"])
      .optional()
      .describe("Which kinds of post to include. Default posts_with_replies."),
    include_pins: z.boolean().optional().describe("Include the account's pinned post. Default true."),
    cursor: z.string().optional(),
    ...accountArg,
  },
  risk: "read",
  handler: async ({ actor, limit, since_hours, filter, include_pins, cursor, account }, ctx) => {
    const max = clamp(limit, 25, 500);
    const cutoff = since_hours ? Date.now() - since_hours * 3_600_000 : undefined;
    const query = {
      actor: cleanActor(actor),
      filter: filter ?? "posts_with_replies",
      includePins: include_pins ?? true,
    };

    const result = await paginate<FeedItem>(
      async (next, size) => {
        const params = { ...query, limit: size, cursor: next ?? cursor };
        const data = ctx.client.accounts.length
          ? await ctx.client.call<{ feed?: FeedItem[]; cursor?: string }>(
              ctx.account(account),
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
      cutoff ? { stop: olderThan(cutoff) } : {},
    );

    return renderFeed(result.items, {
      cursor: result.cursor,
      source: `@${cleanActor(actor)}`,
      note: since_hours ? `Last ${since_hours}h.` : undefined,
    });
  },
});

const getLikedPosts = defineTool({
  name: "get_liked_posts",
  title: "Read posts you have liked",
  description:
    "Posts a connected account has liked, newest first. Only works for your own accounts, because Bluesky does not expose anyone else's likes as a feed.",
  schema: {
    limit: z.number().int().min(1).max(500).optional().describe("How many. Default 50."),
    cursor: z.string().optional(),
    ...accountArg,
  },
  risk: "read",
  handler: async ({ limit, cursor, account }, ctx) => {
    const chosen = ctx.account(account);
    const session = await ctx.client.session(chosen);
    const max = clamp(limit, 50, 500);

    const result = await paginate<FeedItem>(async (next, size) => {
      const data = await ctx.client.call<{ feed?: FeedItem[]; cursor?: string }>(
        chosen,
        "app.bsky.feed.getActorLikes",
        { query: { actor: session.did, limit: size, cursor: next ?? cursor } },
      );
      return { items: data.feed ?? [], cursor: data.cursor };
    }, max);

    return renderFeed(result.items, { cursor: result.cursor, source: `likes of @${session.handle}` });
  },
});

const getPostLikes = defineTool({
  name: "get_post_likes",
  title: "See who liked a post",
  description: "The accounts that liked a specific post, newest first.",
  schema: {
    uri: z.string().describe("at:// URI or bsky.app link of the post."),
    ...pageArgs,
    ...accountArg,
  },
  risk: "read",
  handler: async ({ uri, limit, cursor, account }, ctx) => {
    const resolved = await resolvePostUri(ctx.client, uri);
    const query = { uri: resolved, limit: clamp(limit, 50), cursor };
    const data = ctx.client.accounts.length
      ? await ctx.client.call<{ likes?: any[]; cursor?: string }>(
          ctx.account(account),
          "app.bsky.feed.getLikes",
          { query },
        )
      : await ctx.client.publicCall<{ likes?: any[]; cursor?: string }>("app.bsky.feed.getLikes", query);

    return renderActors(
      (data.likes ?? []).map((l) => l.actor).filter(Boolean),
      { cursor: data.cursor, source: `likes on ${resolved}` },
    );
  },
});

const getRepostedBy = defineTool({
  name: "get_reposted_by",
  title: "See who reposted a post",
  description: "The accounts that reposted a specific post.",
  schema: {
    uri: z.string().describe("at:// URI or bsky.app link of the post."),
    ...pageArgs,
    ...accountArg,
  },
  risk: "read",
  handler: async ({ uri, limit, cursor, account }, ctx) => {
    const resolved = await resolvePostUri(ctx.client, uri);
    const query = { uri: resolved, limit: clamp(limit, 50), cursor };
    const data = ctx.client.accounts.length
      ? await ctx.client.call<{ repostedBy?: any[]; cursor?: string }>(
          ctx.account(account),
          "app.bsky.feed.getRepostedBy",
          { query },
        )
      : await ctx.client.publicCall<{ repostedBy?: any[]; cursor?: string }>(
          "app.bsky.feed.getRepostedBy",
          query,
        );

    return renderActors(data.repostedBy ?? [], {
      cursor: data.cursor,
      source: `reposts of ${resolved}`,
    });
  },
});

const getQuotes = defineTool({
  name: "get_quotes",
  title: "See who quoted a post",
  description:
    "Posts that quote a specific post. This is where the argument about a post usually lives: quotes carry commentary, reposts do not.",
  schema: {
    uri: z.string().describe("at:// URI or bsky.app link of the post."),
    ...pageArgs,
    ...accountArg,
  },
  risk: "read",
  handler: async ({ uri, limit, cursor, account }, ctx) => {
    const resolved = await resolvePostUri(ctx.client, uri);
    const query = { uri: resolved, limit: clamp(limit, 25), cursor };
    const data = ctx.client.accounts.length
      ? await ctx.client.call<{ posts?: any[]; cursor?: string }>(
          ctx.account(account),
          "app.bsky.feed.getQuotes",
          { query },
        )
      : await ctx.client.publicCall<{ posts?: any[]; cursor?: string }>("app.bsky.feed.getQuotes", query);

    return renderFeed((data.posts ?? []).map((post) => ({ post })), {
      cursor: data.cursor,
      source: `quotes of ${resolved}`,
    });
  },
});

export const readTools: AnyToolSpec[] = [
  getTimeline as AnyToolSpec,
  getAuthorFeed as AnyToolSpec,
  getLikedPosts as AnyToolSpec,
  getPostLikes as AnyToolSpec,
  getRepostedBy as AnyToolSpec,
  getQuotes as AnyToolSpec,
];
