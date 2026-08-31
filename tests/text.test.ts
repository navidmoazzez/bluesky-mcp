import { describe, expect, it } from "vitest";
import {
  assertPostLength,
  byteLength,
  escapeXml,
  graphemeLength,
  utf16ToUtf8Index,
} from "../src/content/text.js";

describe("grapheme counting", () => {
  it("counts a family emoji as one character, not eleven", () => {
    // The whole reason `z.string().max(300)` is the wrong check: this is one
    // character to Bluesky and eleven UTF-16 code units to JavaScript.
    const family = "👨‍👩‍👧‍👦";
    expect(family.length).toBe(11);
    expect(graphemeLength(family)).toBe(1);
  });

  it("counts a flag as one character", () => {
    expect(graphemeLength("🇸🇪")).toBe(1);
  });

  it("accepts 300 family emoji, which a UTF-16 check would reject", () => {
    const text = "👨‍👩‍👧‍👦".repeat(300);
    expect(text.length).toBeGreaterThan(3000);
    expect(graphemeLength(text)).toBe(300);
    // Over the 3000-byte cap, so it still fails — but on bytes, with a message
    // that says so, rather than on a character count that was never the limit.
    expect(() => assertPostLength(text)).toThrow(/bytes/);
  });

  it("accepts 300 CJK characters", () => {
    const text = "文".repeat(300);
    expect(graphemeLength(text)).toBe(300);
    expect(byteLength(text)).toBe(900);
    expect(() => assertPostLength(text)).not.toThrow();
  });

  it("rejects 301 plain characters and names the overage", () => {
    expect(() => assertPostLength("a".repeat(301))).toThrow(/301 characters/);
  });
});

describe("utf16ToUtf8Index", () => {
  it("accounts for multi-byte characters before the index", () => {
    const text = "🎉 hello";
    // The emoji is 2 UTF-16 units and 4 UTF-8 bytes.
    expect(utf16ToUtf8Index(text, 2)).toBe(4);
    expect(utf16ToUtf8Index(text, 3)).toBe(5);
  });

  it("is zero at the start", () => {
    expect(utf16ToUtf8Index("anything", 0)).toBe(0);
  });
});

describe("escapeXml", () => {
  it("escapes all five entities", () => {
    expect(escapeXml(`<a href="x">&'`)).toBe("&lt;a href=&quot;x&quot;&gt;&amp;&apos;");
  });

  it("handles undefined without throwing", () => {
    expect(escapeXml(undefined)).toBe("");
  });
});
