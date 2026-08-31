import { describe, expect, it } from "vitest";
import { detectFacets, facetsToMarkdown } from "../src/content/facets.js";

const encoder = new TextEncoder();

/** What the bytes at a facet's range actually say. */
function sliceFacet(text: string, facet: { index: { byteStart: number; byteEnd: number } }): string {
  const bytes = encoder.encode(text);
  return new TextDecoder().decode(bytes.slice(facet.index.byteStart, facet.index.byteEnd));
}

describe("link detection", () => {
  it("marks an https URL at the right byte range", () => {
    const text = "read this https://navid.me/post now";
    const { facets } = detectFacets(text);
    expect(facets).toHaveLength(1);
    expect(sliceFacet(text, facets[0]!)).toBe("https://navid.me/post");
    expect(facets[0]!.features[0]).toMatchObject({ uri: "https://navid.me/post" });
  });

  it("shifts offsets past a leading emoji", () => {
    // The bug this exists to prevent: a JS string index here is 4 bytes short,
    // and the rendered link starts mid-URL.
    const text = "🎉 https://example.com";
    const { facets } = detectFacets(text);
    expect(sliceFacet(text, facets[0]!)).toBe("https://example.com");
  });

  it("leaves sentence punctuation out of the URL", () => {
    const text = "see https://example.com/x.";
    const { facets } = detectFacets(text);
    expect(facets[0]!.features[0]).toMatchObject({ uri: "https://example.com/x" });
    expect(sliceFacet(text, facets[0]!)).toBe("https://example.com/x");
  });

  it("keeps a closing paren that the URL itself opened", () => {
    const text = "https://en.wikipedia.org/wiki/Foo_(bar)";
    const { facets } = detectFacets(text);
    expect(facets[0]!.features[0]).toMatchObject({
      uri: "https://en.wikipedia.org/wiki/Foo_(bar)",
    });
  });

  it("links a bare domain with a common TLD", () => {
    const { facets } = detectFacets("posted at navid.me today");
    expect(facets[0]!.features[0]).toMatchObject({ uri: "https://navid.me" });
  });

  it("does not link a bare domain with an unknown TLD", () => {
    const { facets } = detectFacets("see foo.notarealtld today");
    expect(facets).toHaveLength(0);
  });
});

describe("tag detection", () => {
  it("includes the # in the facet range", () => {
    const text = "shipping #buildinpublic today";
    const { facets } = detectFacets(text);
    expect(sliceFacet(text, facets[0]!)).toBe("#buildinpublic");
    expect(facets[0]!.features[0]).toMatchObject({ tag: "buildinpublic" });
  });

  it("ignores a # in the middle of a word", () => {
    const { facets } = detectFacets("issue no#5 filed");
    expect(facets).toHaveLength(0);
  });
});

describe("mention detection", () => {
  it("finds a handle and covers the @ in its range", () => {
    const text = "thanks @alice.bsky.social for this";
    const { mentions } = detectFacets(text);
    expect(mentions).toHaveLength(1);
    expect(mentions[0]!.handle).toBe("alice.bsky.social");
    expect(text.slice(mentions[0]!.start, mentions[0]!.end)).toBe("@alice.bsky.social");
  });

  it("ignores a word that is not a domain", () => {
    // Neither reference server posts mentions at all; the failure mode to avoid
    // when adding them is turning "@everyone" into a lookup for a handle.
    const { mentions } = detectFacets("hey @everyone");
    expect(mentions).toHaveLength(0);
  });
});

describe("facetsToMarkdown", () => {
  const facets = [
    {
      index: { byteStart: 6, byteEnd: 15 },
      features: [{ $type: "app.bsky.richtext.facet#link", uri: "https://example.com/very/long" }],
    },
  ];

  it("restores a truncated link to its real target", () => {
    // Bluesky shortens the visible text; a model following the shortened form
    // gets a 404, so the real URI has to survive the round trip.
    expect(facetsToMarkdown("read: example.c ok", facets)).toBe(
      "read: [example.c](https://example.com/very/long) ok",
    );
  });

  it("uses autolink syntax when the text is already the URL", () => {
    const text = "go https://a.io now";
    const f = [
      {
        index: { byteStart: 3, byteEnd: 15 },
        features: [{ $type: "app.bsky.richtext.facet#link", uri: "https://a.io" }],
      },
    ];
    expect(facetsToMarkdown(text, f)).toBe("go <https://a.io> now");
  });

  it("returns the text untouched when there are no facets", () => {
    expect(facetsToMarkdown("plain text", undefined)).toBe("plain text");
  });

  it("survives a facet whose range is out of bounds", () => {
    const f = [{ index: { byteStart: 0, byteEnd: 9999 }, features: [] }];
    expect(facetsToMarkdown("short", f)).toBe("short");
  });
});
