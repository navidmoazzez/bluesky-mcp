/**
 * Profiles and the social graph.
 *
 * `get_profile` takes a list, not a single handle. Looking up five accounts is
 * one call to `getProfiles`, and a model comparing accounts otherwise makes
 * five round trips because the tool only offered one at a time.
 *
 * `get_relationships` answers the question that actually matters before an
 * action: do I follow them, do they follow me, have either of us blocked the
 * other.
 */

import { z } from "zod";
import { cleanActor, resolveDid, resolveRecordUri } from "../api/identity.js";
import { renderActors, renderProfile } from "../format/posts.js";
import { escapeXml } from "../content/text.js";
import { accountArg, clamp, defineTool, pageArgs, paginate, type AnyToolSpec } from "./kit.js";

type Any = Record<string, any>;

const getProfile = defineTool({
  name: "get_profile",
  title: "Read a profile",
  description:
    "Full profile for one or more accounts: bio, follower counts, labels, and, when a connected account is available, whether you follow them and whether they follow you. Works without credentials.",
  schema: {
    actors: z
      .array(z.string())
      .min(1)
      .max(25)
      .describe("Handles (with or without @) or DIDs. Up to 25 in one call."),
    ...accountArg,
  },
  risk: "read",
  handler: async ({ actors, account }, ctx) => {
    const cleaned = actors.map(cleanActor);
    const query = { actors: cleaned };
    const data = ctx.client.accounts.length
      ? await ctx.client.call<{ profiles?: Any[] }>(
          ctx.account(account),
          "app.bsky.actor.getProfiles",
          { query },
        )
      : await ctx.client.publicCall<{ profiles?: Any[] }>("app.bsky.actor.getProfiles", query);

    const profiles = data.profiles ?? [];
    const only = profiles.length === 1 ? profiles[0] : undefined;
    if (only) return renderProfile(only);
    return `<profiles count="${profiles.length}">\n${profiles.map((p) => renderProfile(p)).join("")}</profiles>\n`;
  },
});

const getFollowers = defineTool({
  name: "get_followers",
  title: "List followers",
  description:
    "Accounts that follow a given account, newest first. Pages automatically past Bluesky's 100 ceiling.",
  schema: {
    actor: z.string().describe("Handle or DID."),
    limit: z.number().int().min(1).max(1000).optional().describe("How many. Default 50."),
    cursor: z.string().optional(),
    ...accountArg,
  },
  risk: "read",
  handler: async ({ actor, limit, cursor, account }, ctx) => {
    const max = clamp(limit, 50, 1000);
    const who = cleanActor(actor);

    const result = await paginate<Any>(async (next, size) => {
      const params = { actor: who, limit: size, cursor: next ?? cursor };
      const data = ctx.client.accounts.length
        ? await ctx.client.call<{ followers?: Any[]; cursor?: string }>(
            ctx.account(account),
            "app.bsky.graph.getFollowers",
            { query: params },
          )
        : await ctx.client.publicCall<{ followers?: Any[]; cursor?: string }>(
            "app.bsky.graph.getFollowers",
            params,
          );
      return { items: data.followers ?? [], cursor: data.cursor };
    }, max);

    return renderActors(result.items, { cursor: result.cursor, source: `followers of @${who}` });
  },
});

const getFollows = defineTool({
  name: "get_follows",
  title: "List who an account follows",
  description: "Accounts a given account follows. Pages automatically.",
  schema: {
    actor: z.string().describe("Handle or DID."),
    limit: z.number().int().min(1).max(1000).optional().describe("How many. Default 50."),
    cursor: z.string().optional(),
    ...accountArg,
  },
  risk: "read",
  handler: async ({ actor, limit, cursor, account }, ctx) => {
    const max = clamp(limit, 50, 1000);
    const who = cleanActor(actor);

    const result = await paginate<Any>(async (next, size) => {
      const params = { actor: who, limit: size, cursor: next ?? cursor };
      const data = ctx.client.accounts.length
        ? await ctx.client.call<{ follows?: Any[]; cursor?: string }>(
            ctx.account(account),
            "app.bsky.graph.getFollows",
            { query: params },
          )
        : await ctx.client.publicCall<{ follows?: Any[]; cursor?: string }>(
            "app.bsky.graph.getFollows",
            params,
          );
      return { items: data.follows ?? [], cursor: data.cursor };
    }, max);

    return renderActors(result.items, { cursor: result.cursor, source: `@${who} follows` });
  },
});

const getRelationships = defineTool({
  name: "get_relationships",
  title: "Check follow relationships",
  description:
    "For each account named, whether a connected account follows them and whether they follow back. One call for a whole list. Use this before a bulk follow or unfollow rather than reading a profile each time.",
  schema: {
    actors: z.array(z.string()).min(1).max(30).describe("Handles or DIDs to check."),
    ...accountArg,
  },
  risk: "read",
  handler: async ({ actors, account }, ctx) => {
    const chosen = ctx.account(account);
    const session = await ctx.client.session(chosen);
    const dids = await Promise.all(actors.map((a) => resolveDid(ctx.client, a)));

    const data = await ctx.client.call<{ relationships?: Any[] }>(
      chosen,
      "app.bsky.graph.getRelationships",
      { query: { actor: session.did, others: dids } },
    );

    let out = `<relationships subject="${escapeXml(session.handle)}" count="${(data.relationships ?? []).length}">\n`;
    for (const [index, rel] of (data.relationships ?? []).entries()) {
      out += `  <relationship`;
      out += ` actor="${escapeXml(actors[index] ?? rel.did ?? "")}"`;
      out += ` did="${escapeXml(rel.did ?? "")}"`;
      out += ` following="${Boolean(rel.following)}"`;
      out += ` followed_by="${Boolean(rel.followedBy)}"`;
      out += ` />\n`;
    }
    out += `</relationships>\n`;
    return out;
  },
});

const getLists = defineTool({
  name: "get_lists",
  title: "List an account's lists",
  description:
    "Curated lists an account has created. Pass a returned URI to get_list_posts to read the feed, or get_list_members to see who is on it.",
  schema: {
    actor: z.string().describe("Handle or DID."),
    ...pageArgs,
    ...accountArg,
  },
  risk: "read",
  handler: async ({ actor, limit, cursor, account }, ctx) => {
    const who = cleanActor(actor);
    const query = { actor: who, limit: clamp(limit, 50), cursor };
    const data = ctx.client.accounts.length
      ? await ctx.client.call<{ lists?: Any[]; cursor?: string }>(
          ctx.account(account),
          "app.bsky.graph.getLists",
          { query },
        )
      : await ctx.client.publicCall<{ lists?: Any[]; cursor?: string }>("app.bsky.graph.getLists", query);

    const lists = data.lists ?? [];
    let out = `<lists count="${lists.length}" source="@${escapeXml(who)}"`;
    if (data.cursor) out += ` cursor="${escapeXml(data.cursor)}"`;
    out += ">\n";
    for (const list of lists) {
      out += `  <list uri="${escapeXml(list.uri)}" name="${escapeXml(list.name)}"`;
      out += ` purpose="${escapeXml(String(list.purpose ?? "").split("#").pop() ?? "")}"`;
      out += ` items="${list.listItemCount ?? 0}"`;
      if (list.description) {
        out += `>\n    <description>${escapeXml(list.description)}</description>\n  </list>\n`;
      } else {
        out += ` />\n`;
      }
    }
    out += `</lists>\n`;
    return out;
  },
});

const getListMembers = defineTool({
  name: "get_list_members",
  title: "List the accounts on a list",
  description: "The accounts on a curated list.",
  schema: {
    list: z.string().describe("at:// URI or bsky.app link of the list."),
    limit: z.number().int().min(1).max(500).optional().describe("How many. Default 50."),
    cursor: z.string().optional(),
    ...accountArg,
  },
  risk: "read",
  handler: async ({ list, limit, cursor, account }, ctx) => {
    const uri = await resolveRecordUri(ctx.client, list);
    const max = clamp(limit, 50, 500);

    const result = await paginate<Any>(async (next, size) => {
      const params = { list: uri, limit: size, cursor: next ?? cursor };
      const data = ctx.client.accounts.length
        ? await ctx.client.call<{ items?: Any[]; cursor?: string }>(
            ctx.account(account),
            "app.bsky.graph.getList",
            { query: params },
          )
        : await ctx.client.publicCall<{ items?: Any[]; cursor?: string }>("app.bsky.graph.getList", params);
      return { items: data.items ?? [], cursor: data.cursor };
    }, max);

    return renderActors(
      result.items.map((i) => i.subject).filter(Boolean),
      { cursor: result.cursor, source: uri },
    );
  },
});

export const graphTools: AnyToolSpec[] = [
  getProfile as AnyToolSpec,
  getFollowers as AnyToolSpec,
  getFollows as AnyToolSpec,
  getRelationships as AnyToolSpec,
  getLists as AnyToolSpec,
  getListMembers as AnyToolSpec,
];
