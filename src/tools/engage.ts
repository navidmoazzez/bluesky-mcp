/**
 * Liking, reposting, following, muting, blocking — and undoing all of it.
 *
 * Neither reference server can undo anything. brianellin's has `like-post` and
 * `follow-user` and no way back; berlinbra's has neither. That is a real gap,
 * because the interesting instruction is "unfollow everyone I followed by
 * mistake last week", and an agent that can only add is an agent you cannot let
 * near your graph.
 *
 * Undoing works because every one of these actions is itself a record. A like
 * is an `app.bsky.feed.like` record in your repo, and the post view tells you
 * its URI in `viewer.like`. Unliking is deleting that record. The same shape
 * covers reposts, follows and blocks.
 */

import { z } from "zod";
import { parseAtUri, resolveDid, resolvePostUri, strongRef } from "../api/identity.js";
import { NotFoundError, ValidationError } from "../api/errors.js";
import type { Account } from "../config.js";
import { accountArg, confirmArg, defineTool, type ToolContext, type AnyToolSpec } from "./kit.js";

/** Create a record whose only content is a subject and a timestamp. */
async function createSubjectRecord(
  ctx: ToolContext,
  chosen: Account,
  collection: string,
  subject: unknown,
): Promise<{ uri: string; cid: string }> {
  const session = await ctx.client.session(chosen);
  return ctx.client.call<{ uri: string; cid: string }>(chosen, "com.atproto.repo.createRecord", {
    method: "POST",
    body: {
      repo: session.did,
      collection,
      record: { $type: collection, subject, createdAt: new Date().toISOString() },
    },
  });
}

/** Delete a record of ours by its at:// URI. */
async function deleteOwnRecord(ctx: ToolContext, chosen: Account, uri: string): Promise<void> {
  const { repo, collection, rkey } = parseAtUri(uri);
  await ctx.client.call(chosen, "com.atproto.repo.deleteRecord", {
    method: "POST",
    body: { repo, collection, rkey },
  });
}

/** The viewer state on a post: which of our own records already point at it. */
async function postViewerState(
  ctx: ToolContext,
  chosen: Account,
  uri: string,
): Promise<{ like?: string; repost?: string; cid?: string }> {
  const data = await ctx.client.call<{ posts?: { cid?: string; viewer?: { like?: string; repost?: string } }[] }>(
    chosen,
    "app.bsky.feed.getPosts",
    { query: { uris: [uri] } },
  );
  const post = data.posts?.[0];
  if (!post) {
    throw new NotFoundError(`No post at ${uri}.`, 404, "app.bsky.feed.getPosts", "RecordNotFound");
  }
  return { like: post.viewer?.like, repost: post.viewer?.repost, cid: post.cid };
}

const likePost = defineTool({
  name: "like_post",
  title: "Like a post",
  description:
    "Like a post. Accepts an at:// URI or a bsky.app link. Liking twice is harmless — the existing like is returned rather than a second one created.",
  schema: {
    uri: z.string().describe("at:// URI or bsky.app link of the post."),
    ...accountArg,
  },
  risk: "write",
  idempotent: true,
  summary: (a) => `like ${a.uri}`,
  handler: async ({ uri, account }, ctx) => {
    const chosen = ctx.account(account);
    const resolved = await resolvePostUri(ctx.client, uri);
    const existing = await postViewerState(ctx, chosen, resolved);
    if (existing.like) return { liked: resolved, like_uri: existing.like, already: true };

    const subject = await strongRef(ctx.client, chosen, resolved);
    const result = await createSubjectRecord(ctx, chosen, "app.bsky.feed.like", subject);
    return { liked: resolved, like_uri: result.uri };
  },
});

const unlikePost = defineTool({
  name: "unlike_post",
  title: "Remove a like",
  description:
    "Remove your like from a post. Finds your own like record from the post's viewer state, so you only need the post, not the like.",
  schema: {
    uri: z.string().describe("at:// URI or bsky.app link of the post."),
    ...accountArg,
  },
  risk: "write",
  idempotent: true,
  summary: (a) => `unlike ${a.uri}`,
  handler: async ({ uri, account }, ctx) => {
    const chosen = ctx.account(account);
    const resolved = await resolvePostUri(ctx.client, uri);
    const state = await postViewerState(ctx, chosen, resolved);
    if (!state.like) return { unliked: resolved, already: true };
    await deleteOwnRecord(ctx, chosen, state.like);
    return { unliked: resolved };
  },
});

const repost = defineTool({
  name: "repost",
  title: "Repost",
  description:
    "Repost a post to your followers. Reposting twice is harmless. To add your own comment instead, use create_post with `quote`.",
  schema: {
    uri: z.string().describe("at:// URI or bsky.app link of the post."),
    ...accountArg,
  },
  risk: "write",
  idempotent: true,
  summary: (a) => `repost ${a.uri}`,
  handler: async ({ uri, account }, ctx) => {
    const chosen = ctx.account(account);
    const resolved = await resolvePostUri(ctx.client, uri);
    const existing = await postViewerState(ctx, chosen, resolved);
    if (existing.repost) return { reposted: resolved, repost_uri: existing.repost, already: true };

    const subject = await strongRef(ctx.client, chosen, resolved);
    const result = await createSubjectRecord(ctx, chosen, "app.bsky.feed.repost", subject);
    return { reposted: resolved, repost_uri: result.uri };
  },
});

const unrepost = defineTool({
  name: "unrepost",
  title: "Undo a repost",
  description: "Remove your repost of a post.",
  schema: {
    uri: z.string().describe("at:// URI or bsky.app link of the post."),
    ...accountArg,
  },
  risk: "write",
  idempotent: true,
  summary: (a) => `unrepost ${a.uri}`,
  handler: async ({ uri, account }, ctx) => {
    const chosen = ctx.account(account);
    const resolved = await resolvePostUri(ctx.client, uri);
    const state = await postViewerState(ctx, chosen, resolved);
    if (!state.repost) return { unreposted: resolved, already: true };
    await deleteOwnRecord(ctx, chosen, state.repost);
    return { unreposted: resolved };
  },
});

/** The viewer state on a profile: our follow, mute and block records. */
async function actorViewerState(ctx: ToolContext, chosen: Account, actor: string) {
  const did = await resolveDid(ctx.client, actor);
  const profile = await ctx.client.call<{
    handle?: string;
    did?: string;
    viewer?: { following?: string; blocking?: string; muted?: boolean; followedBy?: string };
  }>(chosen, "app.bsky.actor.getProfile", { query: { actor: did } });
  return { did, profile };
}

const follow = defineTool({
  name: "follow",
  title: "Follow an account",
  description: "Follow an account by handle or DID. Following twice is harmless.",
  schema: {
    actor: z.string().describe("Handle (with or without @) or DID."),
    ...accountArg,
  },
  risk: "write",
  idempotent: true,
  summary: (a) => `follow ${a.actor}`,
  handler: async ({ actor, account }, ctx) => {
    const chosen = ctx.account(account);
    const { did, profile } = await actorViewerState(ctx, chosen, actor);
    if (profile.viewer?.following) {
      return { following: did, handle: profile.handle, follow_uri: profile.viewer.following, already: true };
    }
    const result = await createSubjectRecord(ctx, chosen, "app.bsky.graph.follow", did);
    return { following: did, handle: profile.handle, follow_uri: result.uri };
  },
});

const unfollow = defineTool({
  name: "unfollow",
  title: "Unfollow an account",
  description:
    "Stop following an account. Finds your own follow record from the profile's viewer state, so you only need the handle.",
  schema: {
    actor: z.string().describe("Handle (with or without @) or DID."),
    ...accountArg,
  },
  risk: "write",
  idempotent: true,
  summary: (a) => `unfollow ${a.actor}`,
  handler: async ({ actor, account }, ctx) => {
    const chosen = ctx.account(account);
    const { did, profile } = await actorViewerState(ctx, chosen, actor);
    if (!profile.viewer?.following) return { unfollowed: did, handle: profile.handle, already: true };
    await deleteOwnRecord(ctx, chosen, profile.viewer.following);
    return { unfollowed: did, handle: profile.handle };
  },
});

const mute = defineTool({
  name: "mute_account",
  title: "Mute an account",
  description:
    "Hide an account's posts from your feeds without them knowing. Private and reversible — unlike a block, they can still see and reply to you.",
  schema: { actor: z.string().describe("Handle or DID."), ...accountArg },
  risk: "write",
  idempotent: true,
  summary: (a) => `mute ${a.actor}`,
  handler: async ({ actor, account }, ctx) => {
    const chosen = ctx.account(account);
    const did = await resolveDid(ctx.client, actor);
    await ctx.client.call(chosen, "app.bsky.graph.muteActor", { method: "POST", body: { actor: did } });
    return { muted: did };
  },
});

const unmute = defineTool({
  name: "unmute_account",
  title: "Unmute an account",
  description: "Stop hiding an account's posts.",
  schema: { actor: z.string().describe("Handle or DID."), ...accountArg },
  risk: "write",
  idempotent: true,
  summary: (a) => `unmute ${a.actor}`,
  handler: async ({ actor, account }, ctx) => {
    const chosen = ctx.account(account);
    const did = await resolveDid(ctx.client, actor);
    await ctx.client.call(chosen, "app.bsky.graph.unmuteActor", { method: "POST", body: { actor: did } });
    return { unmuted: did };
  },
});

const block = defineTool({
  name: "block_account",
  title: "Block an account",
  description:
    "Block an account. This is visible to them and severs the relationship in both directions: it removes any follow either way, and hides your posts from them. Reversible with unblock_account, but the follows do not come back. Needs confirm: true.",
  schema: { actor: z.string().describe("Handle or DID."), ...accountArg, ...confirmArg },
  risk: "destructive",
  public: true,
  summary: (a) => `block ${a.actor}`,
  handler: async ({ actor, account }, ctx) => {
    const chosen = ctx.account(account);
    const { did, profile } = await actorViewerState(ctx, chosen, actor);
    if (profile.viewer?.blocking) {
      return { blocked: did, handle: profile.handle, block_uri: profile.viewer.blocking, already: true };
    }
    const result = await createSubjectRecord(ctx, chosen, "app.bsky.graph.block", did);
    return { blocked: did, handle: profile.handle, block_uri: result.uri };
  },
});

const unblock = defineTool({
  name: "unblock_account",
  title: "Unblock an account",
  description:
    "Remove a block. Any follows the block severed do not come back — both sides have to follow again.",
  schema: { actor: z.string().describe("Handle or DID."), ...accountArg },
  risk: "write",
  idempotent: true,
  summary: (a) => `unblock ${a.actor}`,
  handler: async ({ actor, account }, ctx) => {
    const chosen = ctx.account(account);
    const { did, profile } = await actorViewerState(ctx, chosen, actor);
    if (!profile.viewer?.blocking) return { unblocked: did, handle: profile.handle, already: true };
    await deleteOwnRecord(ctx, chosen, profile.viewer.blocking);
    return { unblocked: did, handle: profile.handle };
  },
});

const setReplyPermissions = defineTool({
  name: "set_reply_permissions",
  title: "Change who can reply",
  description:
    "Change who is allowed to reply to one of your existing posts, after it is already published. Also lets you hide specific replies from the thread. Neither reference server exposes this, and it is the main tool for a post that is going badly.",
  schema: {
    uri: z.string().describe("at:// URI or bsky.app link of your post."),
    who: z
      .enum(["everyone", "nobody", "mentioned", "following", "followers"])
      .describe("Who may reply from now on. Existing replies stay unless you hide them."),
    hide_replies: z
      .array(z.string())
      .max(300)
      .optional()
      .describe("URIs of replies to hide from the thread."),
    ...accountArg,
  },
  risk: "write",
  summary: (a) => `set replies on ${a.uri} to ${a.who}`,
  handler: async ({ uri, who, hide_replies, account }, ctx) => {
    const chosen = ctx.account(account);
    const session = await ctx.client.session(chosen);
    const resolved = await resolvePostUri(ctx.client, uri, session.did);
    const { repo, rkey } = parseAtUri(resolved);

    if (repo !== session.did) {
      throw new ValidationError(
        `That post belongs to ${repo}. You can only set reply permissions on your own posts.`,
        400,
        "(local)",
        "InvalidRequest",
      );
    }

    // A threadgate only takes effect on the post that starts a thread. Bluesky
    // accepts one written against a reply and then ignores it, so refuse here
    // rather than reporting a change that never happens.
    const record = await ctx.client.call<{ value?: { reply?: unknown } }>(
      chosen,
      "com.atproto.repo.getRecord",
      { query: { repo, collection: "app.bsky.feed.post", rkey } },
    );
    if (record.value?.reply) {
      throw new ValidationError(
        "That post is a reply, and reply controls only apply to the post that starts a thread. Whoever wrote the thread's first post controls who can reply to it.",
        400,
        "(local)",
        "InvalidRequest",
      );
    }

    const allow =
      who === "everyone"
        ? undefined
        : who === "nobody"
          ? []
          : who === "mentioned"
            ? [{ $type: "app.bsky.feed.threadgate#mentionRule" }]
            : who === "following"
              ? [{ $type: "app.bsky.feed.threadgate#followingRule" }]
              : [{ $type: "app.bsky.feed.threadgate#followerRule" }];

    const hidden = hide_replies?.length
      ? await Promise.all(hide_replies.map((r) => resolvePostUri(ctx.client, r, session.did)))
      : undefined;

    await ctx.client.call(chosen, "com.atproto.repo.putRecord", {
      method: "POST",
      body: {
        repo,
        collection: "app.bsky.feed.threadgate",
        rkey,
        record: {
          $type: "app.bsky.feed.threadgate",
          post: resolved,
          ...(allow ? { allow } : {}),
          ...(hidden ? { hiddenReplies: hidden } : {}),
          createdAt: new Date().toISOString(),
        },
      },
    });

    return { post: resolved, replies: who, hidden_replies: hidden?.length ?? 0 };
  },
});

export const engageTools: AnyToolSpec[] = [
  likePost as AnyToolSpec,
  unlikePost as AnyToolSpec,
  repost as AnyToolSpec,
  unrepost as AnyToolSpec,
  follow as AnyToolSpec,
  unfollow as AnyToolSpec,
  mute as AnyToolSpec,
  unmute as AnyToolSpec,
  block as AnyToolSpec,
  unblock as AnyToolSpec,
  setReplyPermissions as AnyToolSpec,
];
