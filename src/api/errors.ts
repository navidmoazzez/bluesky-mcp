/**
 * Typed errors for every way an XRPC call can fail.
 *
 * The AT Protocol returns a consistent `{error, message}` envelope, and the
 * `error` field is a machine-readable name such as `ExpiredToken`,
 * `RateLimitExceeded` or `InvalidRequest`, and it says far more than the status
 * code does. Both
 * reference servers throw the status away and hand the model a bare string, so
 * a model that could have refreshed a token or resized an image instead just
 * gives up. Each failure here keeps the name, the status and the endpoint, and
 * carries a message naming the actual fix.
 */

export class AtpError extends Error {
  readonly status: number;
  readonly nsid: string;
  /** The AT Protocol error name, e.g. "ExpiredToken". Empty when absent. */
  readonly code: string;
  readonly detail: string;

  constructor(message: string, status: number, nsid: string, code = "", detail = "") {
    super(message);
    this.name = new.target.name;
    this.status = status;
    this.nsid = nsid;
    this.code = code;
    this.detail = detail;
  }

  toJSON(): Record<string, unknown> {
    return {
      error: this.message,
      type: this.name,
      status: this.status,
      endpoint: this.nsid,
      ...(this.code ? { code: this.code } : {}),
      ...(this.detail ? { detail: this.detail } : {}),
    };
  }
}

/** 401, or an `ExpiredToken` / `InvalidToken` body. The session must be re-minted. */
export class AuthenticationError extends AtpError {}

/** 403. Authenticated, but not allowed. Often a public-appview endpoint that needs a session. */
export class ForbiddenError extends AtpError {}

/** 400 `InvalidRequest`, plus the lexicon validation failures. */
export class ValidationError extends AtpError {}

/** 404, or `RecordNotFound` / `NotFound`. */
export class NotFoundError extends AtpError {}

/** 429 `RateLimitExceeded`. Carries the reset time when the server sent one. */
export class RateLimitError extends AtpError {
  /** Unix seconds when the limit resets, when `ratelimit-reset` was present. */
  readonly resetAt?: number;

  constructor(
    message: string,
    status: number,
    nsid: string,
    code: string,
    detail: string,
    resetAt?: number,
  ) {
    super(message, status, nsid, code, detail);
    this.resetAt = resetAt;
  }

  override toJSON(): Record<string, unknown> {
    return {
      ...super.toJSON(),
      ...(this.resetAt ? { reset_at: new Date(this.resetAt * 1000).toISOString() } : {}),
    };
  }
}

/** 5xx. Upstream, usually transient, worth retrying. */
export class ServerError extends AtpError {}

/** Synthetic 408. Nothing arrived before our own deadline. */
export class TimeoutError extends AtpError {}

/** Writes are disabled, or a destructive tool was called without `confirm`. */
export class WriteBlockedError extends AtpError {
  constructor(message: string) {
    super(message, 0, "(local)", "WriteBlocked", "");
  }
}

/** Parsed shape of an XRPC error body. */
export type AtpErrorBody = { code: string; message: string };

/**
 * Pull the `{error, message}` envelope out of a response body.
 *
 * Falls back to raw text, capped at 500 characters, so an HTML error page from
 * a proxy in front of the PDS does not become the whole error message.
 */
export function parseErrorBody(body: string): AtpErrorBody {
  const text = body.trim();
  if (!text) return { code: "", message: "" };

  try {
    const parsed = JSON.parse(text) as unknown;
    if (parsed && typeof parsed === "object") {
      const obj = parsed as Record<string, unknown>;
      return {
        code: typeof obj.error === "string" ? obj.error : "",
        message:
          typeof obj.message === "string"
            ? obj.message.slice(0, 500)
            : typeof obj.error === "string"
              ? obj.error.slice(0, 500)
              : "",
      };
    }
  } catch {
    // Not JSON. Fall through to the raw text.
  }

  return { code: "", message: text.replace(/\s+/g, " ").slice(0, 500) };
}

/** True when this failure means the access token is stale and a refresh would fix it. */
export function isExpiredToken(status: number, code: string): boolean {
  return status === 400 || status === 401
    ? code === "ExpiredToken" || code === "InvalidToken"
    : false;
}

/** Map a status plus an AT Protocol error name onto the right class. */
export function errorFor(
  status: number,
  nsid: string,
  body: string,
  headers?: Headers,
): AtpError {
  const { code, message } = parseErrorBody(body);
  const detail = message;

  if (status === 429 || code === "RateLimitExceeded") {
    const raw = headers?.get("ratelimit-reset");
    const resetAt = raw && /^\d+$/.test(raw) ? Number(raw) : undefined;
    const when = resetAt ? ` Resets at ${new Date(resetAt * 1000).toISOString()}.` : "";
    return new RateLimitError(
      `Bluesky rate limited ${nsid}. The client already backs off and retries; this failed after the last attempt.${when}`,
      status,
      nsid,
      code,
      detail,
      resetAt,
    );
  }
  if (status === 401 || isExpiredToken(status, code)) {
    return new AuthenticationError(
      code === "ExpiredToken" || code === "InvalidToken"
        ? `The Bluesky session expired during ${nsid} and could not be refreshed. Check that the app password is still valid at bsky.app/settings/app-passwords.`
        : `Bluesky rejected the credentials for ${nsid}. Confirm BLUESKY_IDENTIFIER is the full handle and BLUESKY_APP_PASSWORD is an app password, not the account password.`,
      status,
      nsid,
      code,
      detail,
    );
  }
  if (status === 403) {
    return new ForbiddenError(
      `Bluesky refused ${nsid} for this account. Some endpoints (search_posts, the timeline, notifications) require a session and reject the public appview.`,
      status,
      nsid,
      code,
      detail,
    );
  }
  if (status === 400) {
    return new ValidationError(
      `Bluesky rejected the arguments sent to ${nsid}${code ? ` (${code})` : ""}.`,
      status,
      nsid,
      code,
      detail,
    );
  }
  if (status === 404 || code === "RecordNotFound" || code === "NotFound") {
    return new NotFoundError(
      `Not found via ${nsid}. Check the handle, DID or post URI. A deleted post and a post that never existed look the same here.`,
      status,
      nsid,
      code,
      detail,
    );
  }
  if (status >= 500) {
    return new ServerError(
      `Bluesky returned ${status} for ${nsid}. This is upstream and usually transient.`,
      status,
      nsid,
      code,
      detail,
    );
  }
  return new AtpError(`Bluesky returned ${status} for ${nsid}.`, status, nsid, code, detail);
}
