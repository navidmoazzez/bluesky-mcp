/**
 * Handles, DIDs, AT URIs and bsky.app links, and moving between them.
 *
 * A model will hand you whatever the user pasted. That is almost always a
 * bsky.app permalink, occasionally an at:// URI, sometimes a bare handle with
 * an @ on it. Every URI argument goes through `resolvePostUri`, so all three
 * forms work everywhere and no separate conversion step is needed.
 *
 * Note that `did:plc:` is one of two DID methods in use. Gating on it, which is
 * the easy shortcut, also rejects every valid `did:web:` post, and `did:web:`
 * is exactly what a self-hosted PDS uses.
 */

import type { BlueskyClient } from "./client.js";
import { NotFoundError, ValidationError } from "./errors.js";

/** A record reference with its content hash, which every write embed needs. */
export type StrongRef = { uri: string; cid: string };

/** The three parts of an at:// URI. */
export type AtUriParts = { repo: string; collection: string; rkey: string };

const DID_RE = /^did:[a-z]+:[a-zA-Z0-9._%-]+$/;

export function isDid(value: string): boolean {
  return DID_RE.test(value.trim());
}

/** Strip a leading @ and surrounding whitespace. DIDs pass through. */
export function cleanActor(value: string): string {
  const t = value.trim();
  return t.startsWith("did:") ? t : t.replace(/^@/, "");
}

/** Split an at:// URI. Throws with the offending value rather than returning undefined. */
export function parseAtUri(uri: string): AtUriParts {
  const trimmed = uri.trim();
  if (!trimmed.startsWith("at://")) {
    throw new ValidationError(`Not an AT URI: "${uri}"`, 400, "(local)", "InvalidUri");
  }
  const [repo, collection, rkey] = trimmed.slice("at://".length).split("/");
  if (!repo || !collection || !rkey) {
    throw new ValidationError(
      `AT URI is missing a part: "${uri}". Expected at://<did>/<collection>/<rkey>.`,
      400,
      "(local)",
      "InvalidUri",
    );
  }
  return { repo, collection, rkey };
}

/** Build an at:// URI. */
export function atUri(parts: AtUriParts): string {
  return `at://${parts.repo}/${parts.collection}/${parts.rkey}`;
}

/**
 * Pull the handle-or-DID and rkey out of a bsky.app permalink.
 *
 * Accepts /post/, /feed/ and /lists/ paths, and tolerates a query string or
 * fragment, which is what you get from a share sheet.
 */
export function parseWebUrl(
  url: string,
): { actor: string; collection: string; rkey: string } | null {
  const match = url
    .trim()
    .match(/bsky\.app\/profile\/([^/?#]+)\/(post|feed|lists?)\/([^/?#]+)/i);
  if (!match) return null;
  const kind = match[2]!.toLowerCase();
  const collection =
    kind === "post"
      ? "app.bsky.feed.post"
      : kind === "feed"
        ? "app.bsky.feed.generator"
        : "app.bsky.graph.list";
  return { actor: decodeURIComponent(match[1]!), collection, rkey: match[3]! };
}

/** Turn an at:// URI into the permalink a human can click. */
export function webUrl(uri: string, handle?: string): string {
  try {
    const { repo, collection, rkey } = parseAtUri(uri);
    const who = handle || repo;
    const segment =
      collection === "app.bsky.feed.generator"
        ? "feed"
        : collection === "app.bsky.graph.list"
          ? "lists"
          : "post";
    return `https://bsky.app/profile/${who}/${segment}/${rkey}`;
  } catch {
    return "";
  }
}

/** Resolve a handle to a DID. A value that is already a DID is returned as-is. */
export async function resolveDid(client: BlueskyClient, actor: string): Promise<string> {
  const cleaned = cleanActor(actor);
  if (isDid(cleaned)) return cleaned;
  if (!cleaned) {
    throw new ValidationError("No handle given.", 400, "(local)", "InvalidRequest");
  }
  const data = await client.publicCall<{ did?: string }>(
    "com.atproto.identity.resolveHandle",
    { handle: cleaned },
  );
  if (!data.did) {
    throw new NotFoundError(
      `No account resolves for "${actor}". Handles include the domain, e.g. alice.bsky.social.`,
      404,
      "com.atproto.identity.resolveHandle",
      "HandleNotFound",
    );
  }
  return data.did;
}

/**
 * Normalise any reference to a record into an at:// URI.
 *
 * Accepts an at:// URI, a bsky.app permalink, or a bare rkey when `fallbackDid`
 * is supplied (which is how a model that just created a post refers back to it).
 */
export async function resolveRecordUri(
  client: BlueskyClient,
  ref: string,
  fallbackDid?: string,
): Promise<string> {
  const trimmed = ref.trim();
  if (trimmed.startsWith("at://")) {
    parseAtUri(trimmed); // Validate now, not three calls later.
    return trimmed;
  }

  const web = parseWebUrl(trimmed);
  if (web) {
    const did = await resolveDid(client, web.actor);
    return atUri({ repo: did, collection: web.collection, rkey: web.rkey });
  }

  // A bare record key, e.g. "3lbxyz...". Only meaningful with a repo to hang it on.
  if (fallbackDid && /^[a-z0-9]{8,}$/i.test(trimmed)) {
    return atUri({ repo: fallbackDid, collection: "app.bsky.feed.post", rkey: trimmed });
  }

  throw new ValidationError(
    `Could not read "${ref}" as a post. Pass an at:// URI or a bsky.app link like https://bsky.app/profile/<handle>/post/<id>.`,
    400,
    "(local)",
    "InvalidUri",
  );
}

/** Alias that reads better at post-shaped call sites. */
export const resolvePostUri = resolveRecordUri;

/**
 * Fetch the `{uri, cid}` pair for a record.
 *
 * `getRecord` on the PDS is used rather than `getPostThread`, because it works
 * for likes, follows and list records too, and because a thread fetch pulls
 * down replies nobody asked for.
 */
export async function strongRef(
  client: BlueskyClient,
  account: Parameters<BlueskyClient["call"]>[0],
  ref: string,
  fallbackDid?: string,
): Promise<StrongRef> {
  const uri = await resolveRecordUri(client, ref, fallbackDid);
  const { repo, collection, rkey } = parseAtUri(uri);
  const record = await client.call<{ uri: string; cid: string }>(
    account,
    "com.atproto.repo.getRecord",
    { query: { repo, collection, rkey } },
  );
  if (!record.cid) {
    throw new NotFoundError(
      `No record at ${uri}. It may have been deleted.`,
      404,
      "com.atproto.repo.getRecord",
      "RecordNotFound",
    );
  }
  return { uri: record.uri, cid: record.cid };
}
