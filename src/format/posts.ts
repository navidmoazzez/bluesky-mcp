/**
 * Rendering posts for a model to read.
 *
 * berlinbra's server returns `json.dumps(response.model_dump())`. A single
 * timeline page of 50 posts is roughly 90,000 tokens of nested view objects,
 * most of it CIDs, blob refs, viewer state and label arrays, and the model has
 * to find the text inside it. brianellin's server solved this properly with an
 * XML format (POST_FORMAT_SPEC.md) that runs an order of magnitude smaller and
 * reads far better. That idea is the best thing in either repository and it is
 * the one taken wholesale here.
 *
 * What is different:
 *
 *   - **Timestamps are ISO-8601 UTC.** The original uses `toLocaleString()` and
 *     `formatISO9075`, so the same post renders differently depending on the
 *     server's timezone and locale, and a model cannot compare two of them.
 *   - **Every attribute is escaped.** The original escapes in one of its three
 *     rendering paths, so an author whose display name contains a quote emits
 *     malformed XML from the feed renderer and valid XML from the thread one.
 *   - **One renderer.** The original has three near-identical copies of the
 *     post-rendering logic, which is why its embed handling has already drifted
 *     between them (the feed path omits link thumbnails, the thread path keeps
 *     them). Everything here goes through `renderPost`.
 *   - **`recordWithMedia` is handled.** A quote post with an image attached is
 *     extremely common and the original drops it on the floor.
 *   - **Blocked and deleted posts are rendered as themselves** rather than
 *     silently vanishing, so a gap in a thread is visible instead of implied.
 *   - **Labels are surfaced.** A model summarising a feed should be able to see
 *     that a post is labelled, not discover it after quoting it.
 */

import { facetsToMarkdown } from "../content/facets.js";
import { escapeXml } from "../content/text.js";
import { webUrl } from "../api/identity.js";

type Any = Record<string, any>;

/** ISO-8601 in UTC, or the raw value when it will not parse. */
function ts(value: unknown): string {
  if (typeof value !== "string" || !value) return "";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toISOString();
}

function attr(name: string, value: unknown): string {
  if (value === undefined || value === null || value === "") return "";
  return ` ${name}="${escapeXml(value)}"`;
}

function pad(depth: number): string {
  return "  ".repeat(depth);
}

function engagement(post: Any): string {
  const parts = [
    `${post.likeCount ?? 0} likes`,
    `${post.repostCount ?? 0} reposts`,
    `${post.replyCount ?? 0} replies`,
  ];
  if (post.quoteCount) parts.push(`${post.quoteCount} quotes`);
  return parts.join(", ");
}

function labelsOf(subject: Any): string {
  const labels = Array.isArray(subject?.labels) ? subject.labels : [];
  const values = labels.map((l: Any) => l?.val).filter(Boolean);
  return values.length ? values.join(", ") : "";
}

/** The text of a post, with links and mentions stitched back in. */
function contentOf(record: Any): string {
  return facetsToMarkdown(record?.text ?? "", record?.facets);
}

function renderEmbed(embed: Any, depth: number): string {
  if (!embed) return "";
  const type = String(embed.$type ?? "");
  const p = pad(depth);
  let out = "";

  if (type.startsWith("app.bsky.embed.images")) {
    for (const image of embed.images ?? []) {
      out += `${p}<embed type="image"${attr("alt", image.alt || undefined)}${attr("url", image.fullsize || image.thumb)} />\n`;
    }
    return out;
  }

  if (type.startsWith("app.bsky.embed.external")) {
    const e = embed.external ?? {};
    out += `${p}<embed type="link"${attr("url", e.uri)}>\n`;
    if (e.title) out += `${p}  <title>${escapeXml(e.title)}</title>\n`;
    if (e.description) out += `${p}  <description>${escapeXml(e.description)}</description>\n`;
    out += `${p}</embed>\n`;
    return out;
  }

  if (type.startsWith("app.bsky.embed.video")) {
    out += `${p}<embed type="video"${attr("alt", embed.alt || undefined)}${attr("playlist", embed.playlist)}${attr("thumbnail", embed.thumbnail)} />\n`;
    return out;
  }

  // A quote post with media attached. Both halves matter, and the original
  // reference format drops the whole node.
  if (type.startsWith("app.bsky.embed.recordWithMedia")) {
    out += renderEmbed(embed.media, depth);
    out += renderEmbed(embed.record, depth);
    return out;
  }

  if (type.startsWith("app.bsky.embed.record")) {
    const record = embed.record ?? {};
    return renderQuoted(record, depth);
  }

  return out;
}

/** The embedded record of a quote post, in whatever state it is in. */
function renderQuoted(record: Any, depth: number): string {
  const type = String(record?.$type ?? "");
  const p = pad(depth);

  if (type.includes("viewNotFound")) {
    return `${p}<quoted_post state="deleted"${attr("uri", record.uri)} />\n`;
  }
  if (type.includes("viewBlocked")) {
    return `${p}<quoted_post state="blocked"${attr("uri", record.uri)} />\n`;
  }
  if (type.includes("viewDetached")) {
    return `${p}<quoted_post state="detached_by_author"${attr("uri", record.uri)} />\n`;
  }
  if (type.includes("generatorView")) {
    return `${p}<quoted_feed${attr("uri", record.uri)}${attr("name", record.displayName)}${attr("creator", record.creator?.handle)} />\n`;
  }
  if (type.includes("listView")) {
    return `${p}<quoted_list${attr("uri", record.uri)}${attr("name", record.name)}${attr("creator", record.creator?.handle)} />\n`;
  }
  if (!record?.uri || !record?.author) return "";

  const value = record.value ?? {};
  let out = `${p}<quoted_post`;
  out += attr("uri", record.uri);
  out += attr("url", webUrl(record.uri, record.author.handle));
  out += attr("author_name", record.author.displayName);
  out += attr("author_handle", record.author.handle);
  out += attr("posted_at", ts(value.createdAt ?? record.indexedAt));
  out += ">\n";
  out += `${p}  <content>${escapeXml(contentOf(value))}</content>\n`;
  for (const nested of record.embeds ?? []) out += renderEmbed(nested, depth + 1);
  out += `${p}  <engagement>${engagement(record)}</engagement>\n`;
  out += `${p}</quoted_post>\n`;
  return out;
}

export type RenderOptions = {
  /** Mark this post as the one the caller asked about. */
  requested?: boolean;
  /**
   * Renders the replies nested under this post, at whatever depth they land.
   *
   * A callback rather than a rendered string, because indenting an existing
   * block after the fact also indents the continuation lines of the post text
   * inside it, so a two-paragraph post three levels deep comes back with
   * leading spaces its author never typed, and a model cannot tell the
   * difference between the format's whitespace and the author's.
   */
  renderReplies?: (depth: number) => string;
  /**
   * Why this item is in the feed. `#reasonRepost` wraps the post in a
   * `<repost>`; `#reasonPin` only marks it pinned. Treating every reason as a
   * repost, which is the easy mistake, emits an author-less `<repost>` around
   * an account's own pinned post, which reads as someone else having shared it.
   */
  reason?: Any;
  /** URI of the post being replied to, when the feed gave us one. */
  replyParent?: Any;
};

/** One post, and anything hanging off it. Every path renders through here. */
export function renderPost(post: Any, options: RenderOptions = {}, depth = 0): string {
  if (!post?.uri || !post?.author) return "";
  const p = pad(depth);
  const record = post.record ?? {};

  const types: string[] = [];
  types.push(record.reply ? "reply" : "standalone");
  const embedType = String(post.embed?.$type ?? "");
  if (embedType.startsWith("app.bsky.embed.record")) types.push("quote");

  let out = `${p}<post`;
  out += attr("type", types.join(","));
  out += attr("uri", post.uri);
  out += attr("url", webUrl(post.uri, post.author.handle));
  out += attr("author_name", post.author.displayName);
  out += attr("author_handle", post.author.handle);
  out += attr("posted_at", ts(record.createdAt ?? post.indexedAt));
  if (record.reply?.parent?.uri) out += attr("reply_to", record.reply.parent.uri);
  else if (options.replyParent?.uri) out += attr("reply_to", options.replyParent.uri);
  if (record.reply?.root?.uri) out += attr("thread_root", record.reply.root.uri);
  if (String(options.reason?.$type ?? "").includes("reasonPin")) out += ` pinned="true"`;
  const labels = labelsOf(post);
  if (labels) out += attr("labels", labels);
  if (options.requested) out += ` requested="true"`;
  out += ">\n";

  out += `${p}  <content>${escapeXml(contentOf(record))}</content>\n`;
  out += renderEmbed(post.embed, depth + 1);
  out += `${p}  <engagement>${engagement(post)}</engagement>\n`;

  const replies = options.renderReplies?.(depth + 2);
  if (replies) {
    out += `${p}  <replies>\n${replies}${p}  </replies>\n`;
  }

  out += `${p}</post>\n`;

  const reason = options.reason;
  if (reason && String(reason.$type ?? "").includes("reasonRepost")) {
    const by = reason.by ?? {};
    // Re-render one level deeper rather than indenting the finished block, for
    // the same reason replies take a callback: indenting would reach inside
    // <content> and alter the author's own line breaks.
    const inner = renderPost(post, { ...options, reason: undefined }, depth + 1);
    let wrapped = `${p}<repost`;
    wrapped += attr("author_name", by.displayName);
    wrapped += attr("author_handle", by.handle);
    wrapped += attr("reposted_at", ts(reason.indexedAt));
    wrapped += ">\n";
    wrapped += inner;
    wrapped += `${p}</repost>\n`;
    return wrapped;
  }

  return out;
}

/**
 * A feed page: a flat list of posts, each with its own repost wrapper.
 *
 * Deliberately flat. The original groups feed items into threads and nests
 * replies, which reorders the timeline, the one property a reverse-chronological
 * feed is supposed to have, and drops the reply's own position in it. The
 * `thread_root` attribute carries the relationship without moving anything.
 */
export function renderFeed(
  items: Any[],
  meta: { cursor?: string; note?: string; source?: string } = {},
): string {
  let out = `<posts count="${items.length}"`;
  out += attr("source", meta.source);
  out += attr("cursor", meta.cursor);
  out += ">\n";
  if (meta.note) out += `  <note>${escapeXml(meta.note)}</note>\n`;
  for (const item of items) {
    const post = item?.post ?? item;
    out += renderPost(post, { reason: item?.reason, replyParent: item?.reply?.parent }, 1);
  }
  out += "</posts>\n";
  return out;
}

/**
 * A thread: the ancestor chain above the requested post, then its replies.
 *
 * The chain is flattened root-first and rendered top-down, so the conversation
 * reads the way a person would read it and every post lands at its final depth
 * on the first pass. A broken link in the chain, a deleted or blocked parent,
 * is shown where it happened rather than truncating everything above it.
 */
export function renderThread(thread: Any, requestedUri?: string): string {
  const chain: Any[] = [];
  for (let node = thread?.parent; node; node = node.parent) chain.push(node);
  chain.reverse(); // Root first.
  chain.push(thread);

  const wanted = requestedUri ?? thread?.post?.uri;
  return `<posts source="thread">\n${renderChain(chain, 0, 1, wanted)}</posts>\n`;
}

/** Render the ancestor chain top-down, each post nesting the next inside it. */
function renderChain(
  chain: Any[],
  index: number,
  depth: number,
  requestedUri: string | undefined,
): string {
  const node = chain[index];
  if (!node) return "";

  const type = String(node.$type ?? "");
  if (type.includes("notFoundPost") || type.includes("blockedPost")) {
    // The chain breaks here. Show the break, then carry on at the same depth so
    // the rest of the conversation is not lost with it.
    return placeholder(node, depth) + renderChain(chain, index + 1, depth, requestedUri);
  }

  const post = node.post;
  if (!post) return renderChain(chain, index + 1, depth, requestedUri);

  const isLast = index === chain.length - 1;
  return renderPost(
    post,
    {
      requested: Boolean(requestedUri) && post.uri === requestedUri,
      renderReplies: (childDepth) =>
        isLast
          ? (node.replies ?? [])
              .map((child: Any) => renderThreadNode(child, requestedUri, childDepth))
              .join("")
          : renderChain(chain, index + 1, childDepth, requestedUri),
    },
    depth,
  );
}

/** A reply subtree, rendered downward from `node`. */
function renderThreadNode(node: Any, requestedUri: string | undefined, depth: number): string {
  if (!node) return "";
  const type = String(node.$type ?? "");
  if (type.includes("notFoundPost") || type.includes("blockedPost")) {
    return placeholder(node, depth);
  }

  const post = node.post;
  if (!post) return "";

  return renderPost(
    post,
    {
      requested: Boolean(requestedUri) && post.uri === requestedUri,
      renderReplies: (childDepth) =>
        (node.replies ?? [])
          .map((child: Any) => renderThreadNode(child, requestedUri, childDepth))
          .join(""),
    },
    depth,
  );
}

/** A post that exists in the thread but cannot be shown. */
function placeholder(node: Any, depth: number): string {
  const p = pad(depth);
  const state = String(node.$type ?? "").includes("blockedPost") ? "blocked" : "deleted";
  return `${p}<post state="${state}"${attr("uri", node.uri)}${attr("author", node.author?.did)} />\n`;
}

/** A profile, in the same tagged shape as everything else. */
export function renderProfile(profile: Any): string {
  let out = `<profile`;
  out += attr("handle", profile.handle);
  out += attr("did", profile.did);
  out += attr("name", profile.displayName);
  out += attr("url", `https://bsky.app/profile/${profile.handle ?? profile.did}`);
  out += attr("created_at", ts(profile.createdAt));
  const labels = labelsOf(profile);
  if (labels) out += attr("labels", labels);
  out += ">\n";
  if (profile.description) {
    out += `  <bio>${escapeXml(profile.description)}</bio>\n`;
  }
  out += `  <counts followers="${profile.followersCount ?? 0}" following="${profile.followsCount ?? 0}" posts="${profile.postsCount ?? 0}" />\n`;
  const viewer = profile.viewer;
  if (viewer) {
    // Only meaningful on an authenticated read, and exactly what a model needs
    // before it decides whether to follow, mute or reply.
    out += `  <relationship following="${Boolean(viewer.following)}" followed_by="${Boolean(viewer.followedBy)}" muted="${Boolean(viewer.muted)}" blocking="${Boolean(viewer.blocking)}" blocked_by="${Boolean(viewer.blockedBy)}" />\n`;
  }
  if (profile.pinnedPost?.uri) {
    out += `  <pinned_post${attr("uri", profile.pinnedPost.uri)} />\n`;
  }
  out += `</profile>\n`;
  return out;
}

/** A list of profiles, for followers, follows and actor search. */
export function renderActors(
  actors: Any[],
  meta: { cursor?: string; source?: string } = {},
): string {
  let out = `<actors count="${actors.length}"`;
  out += attr("source", meta.source);
  out += attr("cursor", meta.cursor);
  out += ">\n";
  for (const actor of actors) {
    out += `  <actor`;
    out += attr("handle", actor.handle);
    out += attr("did", actor.did);
    out += attr("name", actor.displayName);
    out += attr("followers", actor.followersCount);
    out += attr("following", actor.followsCount);
    out += attr("posts", actor.postsCount);
    if (actor.viewer?.following) out += ` following="true"`;
    if (actor.viewer?.followedBy) out += ` followed_by="true"`;
    if (actor.description) {
      out += `>\n    <bio>${escapeXml(actor.description)}</bio>\n  </actor>\n`;
    } else {
      out += ` />\n`;
    }
  }
  out += `</actors>\n`;
  return out;
}

/** Notifications, grouped so a model can see at a glance what needs a reply. */
export function renderNotifications(
  notifications: Any[],
  meta: { cursor?: string; seenAt?: string } = {},
): string {
  let out = `<notifications count="${notifications.length}"`;
  out += attr("cursor", meta.cursor);
  out += attr("last_seen", ts(meta.seenAt));
  out += ">\n";
  for (const n of notifications) {
    out += `  <notification`;
    out += attr("reason", n.reason);
    out += attr("author_handle", n.author?.handle);
    out += attr("author_name", n.author?.displayName);
    out += attr("uri", n.uri);
    out += attr("subject", n.reasonSubject);
    out += attr("at", ts(n.indexedAt));
    out += ` unread="${!n.isRead}"`;
    const text = n.record?.text;
    if (typeof text === "string" && text) {
      out += `>\n    <content>${escapeXml(facetsToMarkdown(text, n.record?.facets))}</content>\n  </notification>\n`;
    } else {
      out += ` />\n`;
    }
  }
  out += `</notifications>\n`;
  return out;
}

/** Custom feeds and lists, for the discovery tools. */
export function renderFeedGenerators(
  feeds: Any[],
  meta: { cursor?: string; source?: string } = {},
): string {
  let out = `<feeds count="${feeds.length}"`;
  out += attr("source", meta.source);
  out += attr("cursor", meta.cursor);
  out += ">\n";
  for (const feed of feeds) {
    out += `  <feed`;
    out += attr("uri", feed.uri);
    out += attr("name", feed.displayName ?? feed.name);
    out += attr("creator", feed.creator?.handle);
    out += attr("likes", feed.likeCount);
    out += attr("url", webUrl(feed.uri, feed.creator?.handle));
    if (feed.description) {
      out += `>\n    <description>${escapeXml(feed.description)}</description>\n  </feed>\n`;
    } else {
      out += ` />\n`;
    }
  }
  out += `</feeds>\n`;
  return out;
}
