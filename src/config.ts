/**
 * Resolving credentials, and the multi-account model.
 *
 * Two sources, in priority order:
 *   1. BLUESKY_ACCOUNTS   a JSON array, for several accounts at once
 *   2. BLUESKY_IDENTIFIER + BLUESKY_APP_PASSWORD, the single-account variables
 *
 * A single account read from the environment is fine until you run a personal
 * handle and a brand handle from the same client, at which point you are
 * restarting the server to switch. Every tool
 * that acts as someone takes an optional `account` argument matched against the
 * handle, and the account that acts when none is named is chosen deliberately
 * (see `selectAccount`) rather than being whichever one happened to be first.
 */

export type Account = {
  /** Full handle, no leading @. e.g. "alice.bsky.social" */
  handle: string;
  /** An app password from bsky.app/settings/app-passwords, never the login password. */
  appPassword: string;
  /** The PDS this account lives on. Almost always https://bsky.social. */
  service: string;
  /** Cached DID, when known. Resolved on first login otherwise. */
  did?: string;
};

export type Config = {
  accounts: Account[];
  /** Handles preferred, in order, when a tool is called without `account`. */
  preferred: string[];
  readOnly: boolean;
  allowDestructive: boolean;
  requestTimeoutMs: number;
  minRequestIntervalMs: number;
  maxRetries: number;
  /** Public appview, for reads that need no session. */
  publicApi: string;
  /** Video upload/transcode service. */
  videoService: string;
  videoServiceDid: string;
  userAgent: string;
  auditPath?: string;
};

export const DEFAULT_SERVICE = "https://bsky.social";
export const DEFAULT_PUBLIC_API = "https://public.api.bsky.app";
export const DEFAULT_VIDEO_SERVICE = "https://video.bsky.app";
export const DEFAULT_VIDEO_SERVICE_DID = "did:web:video.bsky.app";

/** Strip a leading @ and lowercase. DIDs pass through untouched. */
export function normalizeHandle(raw: string): string {
  const t = raw.trim();
  if (t.startsWith("did:")) return t;
  return t.replace(/^@/, "").toLowerCase();
}

function normalizeService(raw: string | undefined, fallback: string): string {
  const t = (raw ?? "").trim();
  if (!t) return fallback;
  const withScheme = /^https?:\/\//i.test(t) ? t : `https://${t}`;
  return withScheme.replace(/\/+$/, "");
}

function envFlag(name: string, fallback: boolean): boolean {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  return /^(1|true|yes|on)$/i.test(raw.trim());
}

function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) {
    process.stderr.write(`[bluesky-mcp] ${name}="${raw}" is not a positive number. Using ${fallback}.\n`);
    return fallback;
  }
  return n;
}

/**
 * Read `BLUESKY_ACCOUNTS`, a JSON array.
 *
 * Both snake_case and camelCase keys are accepted, because the same JSON tends
 * to be pasted between a shell export and a client config file.
 */
export function accountsFromJson(raw: string | undefined): Account[] {
  if (!raw) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    process.stderr.write("[bluesky-mcp] BLUESKY_ACCOUNTS is not valid JSON. Ignoring it.\n");
    return [];
  }
  if (!Array.isArray(parsed)) return [];

  const out: Account[] = [];
  for (const entry of parsed) {
    if (!entry || typeof entry !== "object") continue;
    const e = entry as Record<string, unknown>;
    const handle = e.handle ?? e.identifier ?? e.username;
    const password = e.app_password ?? e.appPassword ?? e.password;
    if (typeof handle !== "string" || typeof password !== "string") continue;
    if (!handle.trim() || !password.trim()) continue;
    const did = e.did;
    out.push({
      handle: normalizeHandle(handle),
      appPassword: password.trim(),
      service: normalizeService(
        typeof e.service === "string" ? e.service : undefined,
        DEFAULT_SERVICE,
      ),
      did: typeof did === "string" && did.startsWith("did:") ? did : undefined,
    });
  }
  return out;
}

function accountFromSingleEnv(): Account[] {
  const handle = process.env.BLUESKY_IDENTIFIER;
  const password = process.env.BLUESKY_APP_PASSWORD;
  if (!handle || !password) return [];
  return [
    {
      handle: normalizeHandle(handle),
      appPassword: password.trim(),
      service: normalizeService(process.env.BLUESKY_SERVICE_URL, DEFAULT_SERVICE),
    },
  ];
}

export function loadConfig(): Config {
  const fromJson = accountsFromJson(process.env.BLUESKY_ACCOUNTS);
  const accounts = fromJson.length > 0 ? fromJson : accountFromSingleEnv();

  const preferred = (process.env.BLUESKY_DEFAULT_ACCOUNT ?? "")
    .split(",")
    .map((s) => normalizeHandle(s))
    .filter(Boolean);

  return {
    accounts,
    preferred,
    readOnly: envFlag("BLUESKY_READ_ONLY", false),
    allowDestructive: envFlag("BLUESKY_ALLOW_DESTRUCTIVE", true),
    requestTimeoutMs: envInt("BLUESKY_REQUEST_TIMEOUT_MS", 30_000),
    minRequestIntervalMs: envInt("BLUESKY_MIN_REQUEST_INTERVAL_MS", 120),
    maxRetries: envInt("BLUESKY_MAX_RETRIES", 3),
    publicApi: normalizeService(process.env.BLUESKY_PUBLIC_API, DEFAULT_PUBLIC_API),
    videoService: normalizeService(process.env.BLUESKY_VIDEO_SERVICE, DEFAULT_VIDEO_SERVICE),
    videoServiceDid: process.env.BLUESKY_VIDEO_SERVICE_DID || DEFAULT_VIDEO_SERVICE_DID,
    userAgent: process.env.BLUESKY_USER_AGENT || "bluesky-mcp",
    auditPath: process.env.BLUESKY_AUDIT_LOG || undefined,
  };
}

/**
 * Pick which account a call acts as.
 *
 * With no hint: the first configured `BLUESKY_DEFAULT_ACCOUNT` that is actually
 * connected, else the first account. Exact handle match beats prefix match:
 * "brand.example.com" starts with "brand", so a pure prefix search would hand
 * an unnamed post to the wrong account whenever both exist.
 */
export function selectAccount(config: Config, hint?: string): Account {
  if (config.accounts.length === 0) {
    throw new Error(
      "No Bluesky account configured. Set BLUESKY_IDENTIFIER and BLUESKY_APP_PASSWORD (an app password from bsky.app/settings/app-passwords), or BLUESKY_ACCOUNTS for several at once. Run `bluesky-mcp doctor` for details.",
    );
  }

  if (!hint) {
    for (const want of config.preferred) {
      const exact = config.accounts.find((a) => a.handle === want);
      if (exact) return exact;
      const prefix = config.accounts.find((a) => a.handle.startsWith(want));
      if (prefix) return prefix;
    }
    return config.accounts[0]!;
  }

  const needle = normalizeHandle(hint);
  const byDid = needle.startsWith("did:")
    ? config.accounts.find((a) => a.did === needle)
    : undefined;
  if (byDid) return byDid;

  const exact = config.accounts.find((a) => a.handle === needle);
  if (exact) return exact;

  const prefix = config.accounts.find((a) => a.handle.startsWith(needle));
  if (prefix) return prefix;

  const known = config.accounts.map((a) => a.handle).join(", ");
  throw new Error(
    `No connected Bluesky account matches "${hint}". Connected: ${known || "(none)"}`,
  );
}
