import { describe, expect, it } from "vitest";
import { accountsFromJson, normalizeHandle, selectAccount, type Config } from "../src/config.js";

function config(handles: string[], preferred: string[] = []): Config {
  return {
    accounts: handles.map((handle) => ({
      handle,
      appPassword: "x",
      service: "https://bsky.social",
    })),
    preferred,
    readOnly: false,
    allowDestructive: true,
    requestTimeoutMs: 1000,
    minRequestIntervalMs: 0,
    maxRetries: 0,
    publicApi: "https://public.api.bsky.app",
    videoService: "https://video.bsky.app",
    videoServiceDid: "did:web:video.bsky.app",
    userAgent: "test",
  };
}

describe("accountsFromJson", () => {
  it("accepts snake_case and camelCase alike", () => {
    const parsed = accountsFromJson(
      JSON.stringify([
        { handle: "a.bsky.social", app_password: "p1" },
        { identifier: "@B.bsky.social", appPassword: "p2", service: "pds.example.com" },
      ]),
    );
    expect(parsed).toHaveLength(2);
    expect(parsed[0]).toMatchObject({ handle: "a.bsky.social", service: "https://bsky.social" });
    // Lowercased, @ stripped, and a bare host given a scheme.
    expect(parsed[1]).toMatchObject({ handle: "b.bsky.social", service: "https://pds.example.com" });
  });

  it("ignores entries missing a password", () => {
    expect(accountsFromJson(JSON.stringify([{ handle: "a.bsky.social" }]))).toHaveLength(0);
  });

  it("returns nothing for malformed JSON instead of throwing", () => {
    expect(accountsFromJson("{not json")).toEqual([]);
    expect(accountsFromJson(undefined)).toEqual([]);
  });
});

describe("selectAccount", () => {
  it("prefers an exact match over a prefix match", () => {
    // "brand.example.com" starts with "brand", so a prefix-first search would
    // hand an unnamed post to the wrong account whenever both exist.
    const c = config(["brand.example.com", "brand.bsky.social"], ["brand.bsky.social"]);
    expect(selectAccount(c).handle).toBe("brand.bsky.social");
  });

  it("falls back to the first account when no preference matches", () => {
    expect(selectAccount(config(["a.bsky.social", "b.bsky.social"], ["z"])).handle).toBe(
      "a.bsky.social",
    );
  });

  it("matches a hint by prefix", () => {
    expect(selectAccount(config(["alice.bsky.social"]), "alice").handle).toBe("alice.bsky.social");
    expect(selectAccount(config(["alice.bsky.social"]), "@ALICE.bsky.social").handle).toBe(
      "alice.bsky.social",
    );
  });

  it("names the connected accounts when the hint matches none", () => {
    expect(() => selectAccount(config(["a.bsky.social"]), "nope")).toThrow(/Connected: a.bsky.social/);
  });

  it("explains how to configure an account when there are none", () => {
    expect(() => selectAccount(config([]))).toThrow(/app-passwords/);
  });
});

describe("normalizeHandle", () => {
  it("strips @ and lowercases", () => {
    expect(normalizeHandle("  @Alice.BSky.Social ")).toBe("alice.bsky.social");
  });

  it("leaves a DID untouched", () => {
    expect(normalizeHandle("did:plc:AbC")).toBe("did:plc:AbC");
  });
});
