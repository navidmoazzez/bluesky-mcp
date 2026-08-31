/**
 * Finding things: search, custom feeds, lists, and what is trending.
 *
 * `search_posts` is the one endpoint that genuinely requires a session: the
 * public appview returns 403 for it, which is easy to mistake for broken
 * credentials, so the tool says so rather than passing the 403 through.
 *
 * `get_trends` reads the *current* response shape. The endpoint used to return
 * `postCount` and `startTime` and no longer does, so anything still reading
 * those fields prints "undefined posts" against every topic.
 */

import { z } from "zod";
import { cleanActor, resolveRecordUri } from "../api/identity.js";
import { renderActors, renderFeed, renderFeedGenerators } from "../format/posts.js";
import { escapeXml } from "../content/text.js";
import { accountArg, clamp, defineTool, pageArgs, paginate, type AnyToolSpec } from "./kit.js";

type Any = Record<string, any>;

const searchPosts = defineTool({
  name: "search_posts",
  title: "Search posts",
  description:
    "Full-text search across public posts. Supports Bluesky's search operators: from:handle, to:handle, mentions:handle, domain:example.com, since:YYYY-MM-DD, until:YYYY-MM-DD, lang:en, and \"quoted phrases\". Requires a connected account. Bluesky's public API refuses this endpoint.",
  schema: {
    q: z.string().describe("The query. Operators like from:alice.bsky.social work inside it."),
    sort: z
      .enum(["top", "latest"])
      .optional()
      .describe("'top' for most engaged, 'latest' for newest. Default 'latest'."),
    since: z.string().optional().describe("Only posts after this date, YYYY-MM-DD or an ISO timestamp."),
    until: z.string().optional().describe("Only posts before this date."),
    lang: z.string().optional().describe("Two-letter language code."),
    limit: z.number().int().min(1).max(300).optional().describe("How many. Pages automatically. Default 25."),
    cursor: z.string().optional(),
    ...accountArg,
  },
  risk: "read",
  handler: async ({ q, sort, since, until, lang, limit, cursor, account }, ctx) => {
    const chosen = ctx.account(account);
    const max = clamp(limit, 25, 300);

    const result = await paginate<Any>(async (next, size) => {
      const data = await ctx.client.call<{ posts?: Any[]; cursor?: string }>(
        chosen,
        "app.bsky.feed.searchPosts",
        {
          query: {
            q,
            sort: sort ?? "latest",
            since,
            until,
            lang,
            limit: size,
            cursor: next ?? cursor,
          },
        },
      );
      return { items: data.posts ?? [], cursor: data.cursor };
    }, max);

    return renderFeed(
      result.items.map((post) => ({ post })),
      { cursor: result.cursor, source: `search: ${q}` },
    );
  },
});

const searchActors = defineTool({
  name: "search_actors",
  title: "Search accounts",
  description:
    "Find Bluesky accounts by name, handle or bio text. Works without credentials. Returns each account's bio and follower counts, so you can tell the real one from the impersonators.",
  schema: {
    q: z.string().describe("Name, handle or keyword."),
    limit: z.number().int().min(1).max(100).optional().describe("How many. Default 25."),
    cursor: z.string().optional(),
    ...accountArg,
  },
  risk: "read",
  handler: async ({ q, limit, cursor, account }, ctx) => {
    const query = { q, limit: clamp(limit, 25), cursor };
    const data = ctx.client.accounts.length
      ? await ctx.client.call<{ actors?: Any[]; cursor?: string }>(
          ctx.account(account),
          "app.bsky.actor.searchActors",
          { query },
        )
      : await ctx.client.publicCall<{ actors?: Any[]; cursor?: string }>(
          "app.bsky.actor.searchActors",
          query,
        );
    return renderActors(data.actors ?? [], { cursor: data.cursor, source: `search: ${q}` });
  },
});

const searchFeeds = defineTool({
  name: "search_feeds",
  title: "Search custom feeds",
  description:
    "Find custom feeds, meaning the algorithmic feeds anyone on Bluesky can publish. Pass a feed's URI to get_feed to read it. Works without credentials.",
  schema: {
    q: z.string().describe("What the feed is about, e.g. 'science' or 'book club'."),
    limit: z.number().int().min(1).max(100).optional().describe("How many. Default 10."),
    ...accountArg,
  },
  risk: "read",
  handler: async ({ q, limit, account }, ctx) => {
    const query = { query: q, limit: clamp(limit, 10) };
    const data = ctx.client.accounts.length
      ? await ctx.client.call<{ feeds?: Any[] }>(
          ctx.account(account),
          "app.bsky.unspecced.getPopularFeedGenerators",
          { query },
        )
      : await ctx.client.publicCall<{ feeds?: Any[] }>(
          "app.bsky.unspecced.getPopularFeedGenerators",
          query,
        );
    return renderFeedGenerators(data.feeds ?? [], { source: `feed search: ${q}` });
  },
});

const getFeed = defineTool({
  name: "get_feed",
  title: "Read a custom feed",
  description:
    "Read posts from a custom feed by its at:// URI or bsky.app link. Find one with search_feeds, or your own with get_pinned_feeds.",
  schema: {
    feed: z.string().describe("at:// URI or bsky.app link of the feed."),
    limit: z.number().int().min(1).max(300).optional().describe("How many posts. Pages automatically. Default 30."),
    cursor: z.string().optional(),
    ...accountArg,
  },
  risk: "read",
  handler: async ({ feed, limit, cursor, account }, ctx) => {
    const uri = await resolveRecordUri(ctx.client, feed);
    const max = clamp(limit, 30, 300);

    const result = await paginate<Any>(async (next, size) => {
      const params = { feed: uri, limit: size, cursor: next ?? cursor };
      const data = ctx.client.accounts.length
        ? await ctx.client.call<{ feed?: Any[]; cursor?: string }>(
            ctx.account(account),
            "app.bsky.feed.getFeed",
            { query: params },
          )
        : await ctx.client.publicCall<{ feed?: Any[]; cursor?: string }>("app.bsky.feed.getFeed", params);
      return { items: data.feed ?? [], cursor: data.cursor };
    }, max);

    return renderFeed(result.items, { cursor: result.cursor, source: uri });
  },
});

const getPinnedFeeds = defineTool({
  name: "get_pinned_feeds",
  title: "List your pinned feeds",
  description:
    "The feeds and lists pinned to a connected account's home screen, in order. Pass any of the returned URIs to get_feed or get_list_posts.",
  schema: { ...accountArg },
  risk: "read",
  handler: async ({ account }, ctx) => {
    const chosen = ctx.account(account);
    const prefs = await ctx.client.call<{ preferences?: Any[] }>(
      chosen,
      "app.bsky.actor.getPreferences",
      {},
    );
    const saved = (prefs.preferences ?? []).find((p) =>
      String(p?.$type ?? "").includes("savedFeedsPrefV2"),
    ) as { items?: Any[] } | undefined;

    const items = (saved?.items ?? []).filter((i) => i?.pinned);
    if (items.length === 0) return `<feeds count="0" source="pinned" />\n`;

    // The preference records store only ids and URIs, so the display names have
    // to be fetched. One batched call rather than one per feed.
    const feedUris = items.filter((i) => i.type === "feed" && i.value).map((i) => String(i.value));
    const listUris = items.filter((i) => i.type === "list" && i.value).map((i) => String(i.value));

    const generators = feedUris.length
      ? (
          await ctx.client.call<{ feeds?: Any[] }>(chosen, "app.bsky.feed.getFeedGenerators", {
            query: { feeds: feedUris },
          })
        ).feeds ?? []
      : [];

    const lists = await Promise.all(
      listUris.map(async (uri) => {
        try {
          const data = await ctx.client.call<{ list?: Any }>(chosen, "app.bsky.graph.getList", {
            query: { list: uri, limit: 1 },
          });
          return data.list;
        } catch {
          return undefined;
        }
      }),
    );

    let out = `<feeds count="${items.length}" source="pinned">\n`;
    for (const item of items) {
      if (item.type === "timeline") {
        out += `  <feed type="timeline" name="Following" />\n`;
        continue;
      }
      const generator = generators.find((g) => g.uri === item.value);
      const list = lists.find((l) => l?.uri === item.value);
      const subject = generator ?? list;
      out += `  <feed type="${escapeXml(item.type)}" uri="${escapeXml(item.value)}"`;
      if (subject) {
        out += ` name="${escapeXml(subject.displayName ?? subject.name ?? "")}"`;
        out += ` creator="${escapeXml(subject.creator?.handle ?? "")}"`;
      }
      out += ` />\n`;
    }
    out += `</feeds>\n`;
    return out;
  },
});

const getListPosts = defineTool({
  name: "get_list_posts",
  title: "Read a list feed",
  description:
    "Posts from the accounts on a curated list, newest first. Take the list URI from get_pinned_feeds or a bsky.app /lists/ link.",
  schema: {
    list: z.string().describe("at:// URI or bsky.app link of the list."),
    limit: z.number().int().min(1).max(300).optional().describe("How many posts. Default 30."),
    cursor: z.string().optional(),
    ...accountArg,
  },
  risk: "read",
  handler: async ({ list, limit, cursor, account }, ctx) => {
    const uri = await resolveRecordUri(ctx.client, list);
    const max = clamp(limit, 30, 300);

    const result = await paginate<Any>(async (next, size) => {
      const params = { list: uri, limit: size, cursor: next ?? cursor };
      const data = ctx.client.accounts.length
        ? await ctx.client.call<{ feed?: Any[]; cursor?: string }>(
            ctx.account(account),
            "app.bsky.feed.getListFeed",
            { query: params },
          )
        : await ctx.client.publicCall<{ feed?: Any[]; cursor?: string }>(
            "app.bsky.feed.getListFeed",
            params,
          );
      return { items: data.feed ?? [], cursor: data.cursor };
    }, max);

    return renderFeed(result.items, { cursor: result.cursor, source: uri });
  },
});

const getTrends = defineTool({
  name: "get_trends",
  title: "See what is trending",
  description:
    "Current trending topics on Bluesky, each with the feed link that shows the posts behind it. Works without credentials.",
  schema: {
    limit: z.number().int().min(1).max(50).optional().describe("How many topics. Default 10."),
    include_suggested: z
      .boolean()
      .optional()
      .describe("Also return Bluesky's suggested (not currently trending) topics."),
    ...accountArg,
  },
  risk: "read",
  handler: async ({ limit, include_suggested, account }, ctx) => {
    const query = { limit: clamp(limit, 10, 50) };
    const data = ctx.client.accounts.length
      ? await ctx.client.call<{ topics?: Any[]; suggested?: Any[] }>(
          ctx.account(account),
          "app.bsky.unspecced.getTrendingTopics",
          { query },
        )
      : await ctx.client.publicCall<{ topics?: Any[]; suggested?: Any[] }>(
          "app.bsky.unspecced.getTrendingTopics",
          query,
        );

    const render = (topics: Any[], kind: string) =>
      topics
        .map((t) => {
          const link = t.link ? `https://bsky.app${t.link}` : "";
          let line = `  <topic kind="${kind}" name="${escapeXml(t.displayName ?? t.topic ?? "")}"`;
          if (link) line += ` url="${escapeXml(link)}"`;
          if (t.description) {
            return `${line}>\n    <description>${escapeXml(t.description)}</description>\n  </topic>\n`;
          }
          return `${line} />\n`;
        })
        .join("");

    const topics = data.topics ?? [];
    const suggested = include_suggested ? (data.suggested ?? []) : [];
    return `<trends count="${topics.length + suggested.length}">\n${render(topics, "trending")}${render(suggested, "suggested")}</trends>\n`;
  },
});

const getSuggestions = defineTool({
  name: "get_suggested_follows",
  title: "Get follow suggestions",
  description:
    "Accounts Bluesky suggests following. With an `actor`, returns accounts similar to that one, which is the better way to find a niche.",
  schema: {
    actor: z
      .string()
      .optional()
      .describe("Find accounts similar to this handle or DID. Omit for suggestions for you."),
    limit: z.number().int().min(1).max(100).optional().describe("How many. Default 25."),
    ...accountArg,
  },
  risk: "read",
  handler: async ({ actor, limit, account }, ctx) => {
    const chosen = ctx.account(account);
    const size = clamp(limit, 25);

    if (actor) {
      const data = await ctx.client.call<{ suggestions?: Any[] }>(
        chosen,
        "app.bsky.graph.getSuggestedFollowsByActor",
        { query: { actor: cleanActor(actor) } },
      );
      return renderActors((data.suggestions ?? []).slice(0, size), {
        source: `similar to @${cleanActor(actor)}`,
      });
    }

    const data = await ctx.client.call<{ actors?: Any[]; cursor?: string }>(
      chosen,
      "app.bsky.actor.getSuggestions",
      { query: { limit: size } },
    );
    return renderActors(data.actors ?? [], { cursor: data.cursor, source: "suggested" });
  },
});

export const discoverTools: AnyToolSpec[] = [
  searchPosts as AnyToolSpec,
  searchActors as AnyToolSpec,
  searchFeeds as AnyToolSpec,
  getFeed as AnyToolSpec,
  getPinnedFeeds as AnyToolSpec,
  getListPosts as AnyToolSpec,
  getTrends as AnyToolSpec,
  getSuggestions as AnyToolSpec,
];
