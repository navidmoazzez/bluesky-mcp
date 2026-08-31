/**
 * Measuring text the way the AT Protocol measures it.
 *
 * Three different units matter and they disagree constantly:
 *
 *   - the post limit is 300 **graphemes** and 3000 **bytes** (app.bsky.feed.post)
 *   - facet offsets are **UTF-8 byte** positions
 *   - JavaScript string indices are **UTF-16 code units**
 *
 * `z.string().max(300)` — which is what brianellin's server uses — counts UTF-16
 * code units, so it rejects a perfectly legal post: "👨‍👩‍👧‍👦" is one grapheme
 * and eleven code units, meaning a post of 28 family emoji is refused locally
 * while Bluesky would have accepted it. In the other direction a naive byte
 * count would let a 300-grapheme CJK post through the local check and be
 * rejected by the server. Both units are checked here, separately.
 */

const segmenter =
  typeof Intl !== "undefined" && "Segmenter" in Intl
    ? new Intl.Segmenter(undefined, { granularity: "grapheme" })
    : undefined;

/** Count user-perceived characters, the unit Bluesky's 300 limit is in. */
export function graphemeLength(text: string): number {
  if (!text) return 0;
  if (!segmenter) {
    // Node without full ICU. Array spread counts code points, which is closer
    // than .length and errs toward over-counting, so nothing invalid gets out.
    return [...text].length;
  }
  let n = 0;
  for (const _ of segmenter.segment(text)) n++;
  return n;
}

const encoder = new TextEncoder();

/** UTF-8 byte length, the unit facet offsets and the 3000 cap are in. */
export function byteLength(text: string): number {
  return encoder.encode(text).length;
}

/**
 * Convert a UTF-16 index into a UTF-8 byte offset.
 *
 * Called once per facet boundary rather than per character: encoding the prefix
 * each time is O(n) but n is a 300-grapheme post, and the alternative — a
 * hand-rolled surrogate walk — is where off-by-one facet bugs live.
 */
export function utf16ToUtf8Index(text: string, index: number): number {
  if (index <= 0) return 0;
  return encoder.encode(text.slice(0, index)).length;
}

export const MAX_GRAPHEMES = 300;
export const MAX_BYTES = 3000;

/** Throws with a message naming the actual overage, or returns silently. */
export function assertPostLength(text: string): void {
  const graphemes = graphemeLength(text);
  if (graphemes > MAX_GRAPHEMES) {
    throw new Error(
      `Post is ${graphemes} characters; Bluesky's limit is ${MAX_GRAPHEMES}. Trim ${graphemes - MAX_GRAPHEMES}, or split it into a thread with create_thread.`,
    );
  }
  const bytes = byteLength(text);
  if (bytes > MAX_BYTES) {
    throw new Error(
      `Post is ${bytes} bytes; Bluesky's limit is ${MAX_BYTES}. It is under the ${MAX_GRAPHEMES}-character limit but the characters are wide — trim it or split it into a thread.`,
    );
  }
}

/** Escape the five XML entities. Applied to every attribute and every body. */
export function escapeXml(value: unknown): string {
  if (value === undefined || value === null) return "";
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}
