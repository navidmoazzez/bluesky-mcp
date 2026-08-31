import { describe, expect, it } from "vitest";
import { atUri, cleanActor, isDid, parseAtUri, parseWebUrl, webUrl } from "../src/api/identity.js";

describe("parseWebUrl", () => {
  it("reads a post permalink", () => {
    expect(parseWebUrl("https://bsky.app/profile/alice.bsky.social/post/3lbxyz")).toEqual({
      actor: "alice.bsky.social",
      collection: "app.bsky.feed.post",
      rkey: "3lbxyz",
    });
  });

  it("tolerates a query string from a share sheet", () => {
    expect(parseWebUrl("https://bsky.app/profile/alice.bsky.social/post/3lbxyz?ref=x")?.rkey).toBe(
      "3lbxyz",
    );
  });

  it("reads a DID in the profile position", () => {
    expect(parseWebUrl("https://bsky.app/profile/did:plc:abc/post/3lb")?.actor).toBe("did:plc:abc");
  });

  it("reads feed and list links", () => {
    expect(parseWebUrl("https://bsky.app/profile/a.com/feed/whats-hot")?.collection).toBe(
      "app.bsky.feed.generator",
    );
    expect(parseWebUrl("https://bsky.app/profile/a.com/lists/abc")?.collection).toBe(
      "app.bsky.graph.list",
    );
  });

  it("returns null for anything else", () => {
    expect(parseWebUrl("https://example.com/post/1")).toBeNull();
  });
});

describe("parseAtUri", () => {
  it("splits a well-formed URI", () => {
    expect(parseAtUri("at://did:plc:abc/app.bsky.feed.post/3lb")).toEqual({
      repo: "did:plc:abc",
      collection: "app.bsky.feed.post",
      rkey: "3lb",
    });
  });

  it("accepts did:web, which the reference server rejects", () => {
    // brianellin's get-post-thread requires `at://did:plc:`, so every post on a
    // self-hosted did:web PDS is unreachable through it.
    expect(parseAtUri("at://did:web:example.com/app.bsky.feed.post/3lb").repo).toBe(
      "did:web:example.com",
    );
  });

  it("throws with the offending value", () => {
    expect(() => parseAtUri("https://bsky.app/x")).toThrow(/Not an AT URI/);
    expect(() => parseAtUri("at://did:plc:abc")).toThrow(/missing a part/);
  });
});

describe("webUrl", () => {
  it("round-trips a post URI", () => {
    expect(webUrl("at://did:plc:abc/app.bsky.feed.post/3lb", "alice.bsky.social")).toBe(
      "https://bsky.app/profile/alice.bsky.social/post/3lb",
    );
  });

  it("falls back to the DID when no handle is known", () => {
    expect(webUrl(atUri({ repo: "did:plc:abc", collection: "app.bsky.feed.post", rkey: "3lb" }))).toBe(
      "https://bsky.app/profile/did:plc:abc/post/3lb",
    );
  });

  it("uses the right path segment per collection", () => {
    expect(webUrl("at://did:plc:a/app.bsky.feed.generator/hot")).toContain("/feed/hot");
    expect(webUrl("at://did:plc:a/app.bsky.graph.list/l1")).toContain("/lists/l1");
  });

  it("returns empty rather than throwing on junk", () => {
    expect(webUrl("not a uri")).toBe("");
  });
});

describe("cleanActor and isDid", () => {
  it("strips a leading @", () => {
    expect(cleanActor("@alice.bsky.social")).toBe("alice.bsky.social");
  });

  it("leaves a DID alone", () => {
    expect(cleanActor("did:plc:abc")).toBe("did:plc:abc");
    expect(isDid("did:plc:abc")).toBe(true);
    expect(isDid("alice.bsky.social")).toBe(false);
  });
});
