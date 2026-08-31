import { describe, expect, it } from "vitest";
import { renderFeed, renderPost, renderProfile, renderThread } from "../src/format/posts.js";

const author = { handle: "alice.bsky.social", displayName: 'Alice "A" Smith', did: "did:plc:alice" };

function post(overrides: Record<string, any> = {}) {
  return {
    uri: "at://did:plc:alice/app.bsky.feed.post/3lb",
    cid: "bafy",
    author,
    indexedAt: "2026-01-02T03:04:05.678Z",
    likeCount: 3,
    repostCount: 1,
    replyCount: 2,
    record: { text: "hello", createdAt: "2026-01-02T03:04:05.678Z" },
    ...overrides,
  };
}

describe("attribute escaping", () => {
  it("escapes quotes in a display name", () => {
    // The reference format escapes in one of its three rendering paths, so an
    // author with a quote in their name emits malformed XML from the other two.
    const out = renderPost(post());
    expect(out).toContain('author_name="Alice &quot;A&quot; Smith"');
    expect(out).not.toContain('author_name="Alice "A"');
  });

  it("escapes markup in post text", () => {
    const out = renderPost(post({ record: { text: "<script>&", createdAt: "2026-01-01T00:00:00Z" } }));
    expect(out).toContain("<content>&lt;script&gt;&amp;</content>");
  });
});

describe("timestamps", () => {
  it("renders ISO-8601 UTC regardless of the host timezone", () => {
    // toLocaleString(), which the reference uses, gives a different string on
    // every machine and cannot be compared by the model reading it.
    const out = renderPost(post({ record: { text: "x", createdAt: "2026-01-02T03:04:05.678Z" } }));
    expect(out).toContain('posted_at="2026-01-02T03:04:05.678Z"');
  });

  it("passes an unparseable timestamp through rather than printing Invalid Date", () => {
    const out = renderPost(post({ record: { text: "x", createdAt: "sometime" } }));
    expect(out).toContain('posted_at="sometime"');
    expect(out).not.toContain("Invalid Date");
  });
});

describe("feed items", () => {
  it("wraps a repost and names who reposted it", () => {
    const out = renderFeed([
      {
        post: post(),
        reason: {
          $type: "app.bsky.feed.defs#reasonRepost",
          by: { handle: "bob.example.com", displayName: "Bob" },
          indexedAt: "2026-01-03T00:00:00.000Z",
        },
      },
    ]);
    expect(out).toContain('<repost author_name="Bob" author_handle="bob.example.com"');
    expect(out).toContain('reposted_at="2026-01-03T00:00:00.000Z"');
  });

  it("marks a pinned post pinned rather than wrapping it in an author-less repost", () => {
    const out = renderFeed([{ post: post(), reason: { $type: "app.bsky.feed.defs#reasonPin" } }]);
    expect(out).toContain('pinned="true"');
    expect(out).not.toContain("<repost");
  });

  it("carries the cursor on the root element", () => {
    expect(renderFeed([], { cursor: "abc" })).toContain('cursor="abc"');
  });
});

describe("embeds", () => {
  it("renders a quote plus media, which the reference format drops", () => {
    const out = renderPost(
      post({
        embed: {
          $type: "app.bsky.embed.recordWithMedia#view",
          media: {
            $type: "app.bsky.embed.images#view",
            images: [{ alt: "a chart", fullsize: "https://cdn/x.jpg" }],
          },
          record: {
            $type: "app.bsky.embed.record#view",
            record: {
              $type: "app.bsky.embed.record#viewRecord",
              uri: "at://did:plc:bob/app.bsky.feed.post/3z",
              author: { handle: "bob.example.com", displayName: "Bob" },
              value: { text: "quoted", createdAt: "2026-01-01T00:00:00.000Z" },
              likeCount: 5,
            },
          },
        },
      }),
    );
    expect(out).toContain('<embed type="image" alt="a chart"');
    expect(out).toContain('<quoted_post uri="at://did:plc:bob/app.bsky.feed.post/3z"');
    expect(out).toContain("<content>quoted</content>");
  });

  it("keeps a placeholder for a deleted quoted post", () => {
    const out = renderPost(
      post({
        embed: {
          $type: "app.bsky.embed.record#view",
          record: { $type: "app.bsky.embed.record#viewNotFound", uri: "at://did:plc:x/y/z" },
        },
      }),
    );
    expect(out).toContain('<quoted_post state="deleted"');
  });
});

describe("threads", () => {
  const child = {
    $type: "app.bsky.feed.defs#threadViewPost",
    post: post({
      uri: "at://did:plc:alice/app.bsky.feed.post/3child",
      record: {
        text: "first line\n\nsecond line",
        createdAt: "2026-01-02T04:00:00.000Z",
        reply: {
          parent: { uri: "at://did:plc:alice/app.bsky.feed.post/3lb" },
          root: { uri: "at://did:plc:alice/app.bsky.feed.post/3lb" },
        },
      },
    }),
    replies: [],
  };

  const thread = {
    $type: "app.bsky.feed.defs#threadViewPost",
    post: post(),
    replies: [child],
  };

  it("nests replies under their parent", () => {
    const out = renderThread(thread);
    expect(out).toContain("<replies>");
    expect(out.indexOf("3child")).toBeGreaterThan(out.indexOf("<replies>"));
  });

  it("does not inject indentation into the author's own line breaks", () => {
    // Indenting a rendered block after the fact also indents the continuation
    // lines inside <content>, so the model cannot tell the format's whitespace
    // from the author's.
    const out = renderThread(thread);
    expect(out).toContain("first line\n\nsecond line</content>");
  });

  it("puts an ancestor above the requested post and marks the requested one", () => {
    const out = renderThread(
      { ...child, parent: { $type: "app.bsky.feed.defs#threadViewPost", post: post(), replies: [] } },
      "at://did:plc:alice/app.bsky.feed.post/3child",
    );
    expect(out.indexOf("3lb")).toBeLessThan(out.indexOf("3child"));
    expect(out).toContain('requested="true"');
  });

  it("shows a blocked parent as a gap rather than dropping the thread", () => {
    const out = renderThread({
      ...child,
      parent: { $type: "app.bsky.feed.defs#blockedPost", uri: "at://did:plc:x/y/z" },
    });
    expect(out).toContain('<post state="blocked"');
    expect(out).toContain("3child");
  });
});

describe("profiles", () => {
  it("includes the viewer relationship when authenticated", () => {
    const out = renderProfile({
      ...author,
      followersCount: 10,
      followsCount: 5,
      postsCount: 100,
      description: "bio & stuff",
      viewer: { following: "at://x", muted: false },
    });
    expect(out).toContain('<relationship following="true"');
    expect(out).toContain("<bio>bio &amp; stuff</bio>");
    expect(out).toContain('<counts followers="10" following="5" posts="100" />');
  });
});
