/**
 * Notifications.
 *
 * Neither reference server can mark anything read, which means an agent asked
 * to "deal with my mentions" reads the same twenty every time it runs. Bluesky
 * tracks a single `seenAt` timestamp per account, so marking read is one call
 * so marking read is one call. The omission is not a difficulty, just a gap.
 */

import { z } from "zod";
import { renderNotifications } from "../format/posts.js";
import { accountArg, clamp, defineTool, paginate, type AnyToolSpec } from "./kit.js";

type Any = Record<string, any>;

const REASONS = [
  "like",
  "repost",
  "follow",
  "mention",
  "reply",
  "quote",
  "starterpack-joined",
  "verified",
  "unverified",
  "like-via-repost",
  "repost-via-repost",
] as const;

const getNotifications = defineTool({
  name: "get_notifications",
  title: "Read notifications",
  description:
    "Your likes, reposts, follows, mentions, replies and quotes, newest first. Filter by reason to get just the ones that need an answer: 'mention' and 'reply' are the ones a person actually has to deal with.",
  schema: {
    limit: z.number().int().min(1).max(300).optional().describe("How many. Pages automatically. Default 30."),
    reasons: z
      .array(z.enum(REASONS))
      .optional()
      .describe("Only these kinds. Omit for everything."),
    unread_only: z.boolean().optional().describe("Only notifications since you last marked them seen."),
    cursor: z.string().optional(),
    ...accountArg,
  },
  risk: "read",
  handler: async ({ limit, reasons, unread_only, cursor, account }, ctx) => {
    const chosen = ctx.account(account);
    const max = clamp(limit, 30, 300);

    const result = await paginate<Any>(async (next, size) => {
      const data = await ctx.client.call<{ notifications?: Any[]; cursor?: string; seenAt?: string }>(
        chosen,
        "app.bsky.notification.listNotifications",
        {
          query: {
            limit: size,
            cursor: next ?? cursor,
            ...(reasons?.length ? { reasons } : {}),
          },
        },
      );
      const items = (data.notifications ?? []).filter((n) => (unread_only ? !n.isRead : true));
      return { items, cursor: data.cursor };
    }, max);

    return renderNotifications(result.items, { cursor: result.cursor });
  },
});

const getUnreadCount = defineTool({
  name: "get_unread_count",
  title: "Count unread notifications",
  description:
    "How many notifications have arrived since you last marked them seen. One cheap call, worth making before you pull the full list.",
  schema: { ...accountArg },
  risk: "read",
  handler: async ({ account }, ctx) => {
    const chosen = ctx.account(account);
    const data = await ctx.client.call<{ count?: number }>(
      chosen,
      "app.bsky.notification.getUnreadCount",
      {},
    );
    return { unread: data.count ?? 0, account: (await ctx.client.session(chosen)).handle };
  },
});

const markSeen = defineTool({
  name: "mark_notifications_seen",
  title: "Mark notifications read",
  description:
    "Mark every notification up to now as seen, so the unread count resets. Affects only your own view, and nobody else can tell.",
  schema: {
    seen_at: z
      .string()
      .optional()
      .describe("ISO timestamp to mark seen up to. Defaults to now."),
    ...accountArg,
  },
  risk: "write",
  idempotent: true,
  summary: () => "mark notifications seen",
  handler: async ({ seen_at, account }, ctx) => {
    const chosen = ctx.account(account);
    const seenAt = seen_at ?? new Date().toISOString();
    await ctx.client.call(chosen, "app.bsky.notification.updateSeen", {
      method: "POST",
      body: { seenAt },
    });
    return { seen_at: seenAt };
  },
});

export const notificationTools: AnyToolSpec[] = [
  getNotifications as AnyToolSpec,
  getUnreadCount as AnyToolSpec,
  markSeen as AnyToolSpec,
];
