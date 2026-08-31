/**
 * `bluesky-mcp doctor` — say what is wrong, in the order it will break.
 *
 * The failure people actually hit is using the account password instead of an
 * app password: `createSession` returns a generic 401 and there is nothing in
 * it that names the real cause. So this checks the network, then the
 * credentials, then a real read and a real write scope, and each failure
 * reports the fix rather than the status code.
 */

import { BlueskyClient } from "./api/client.js";
import { loadConfig } from "./config.js";
import { AtpError } from "./api/errors.js";
import { VERSION } from "./server.js";

type Check = { ok: boolean; label: string; detail?: string };

function line(check: Check): string {
  return `${check.ok ? "  ok  " : " FAIL "} ${check.label}${check.detail ? `\n       ${check.detail}` : ""}`;
}

export async function runDoctor(): Promise<number> {
  const config = loadConfig();
  const client = new BlueskyClient(config);
  const checks: Check[] = [];

  process.stdout.write(`bluesky-mcp ${VERSION}\n\n`);

  // 1. Can we reach Bluesky at all.
  try {
    await client.publicCall("app.bsky.actor.getProfile", { actor: "bsky.app" });
    checks.push({ ok: true, label: `public API reachable (${config.publicApi})` });
  } catch (error) {
    checks.push({
      ok: false,
      label: `public API unreachable (${config.publicApi})`,
      detail: (error as Error).message,
    });
  }

  // 2. Are there credentials at all.
  if (config.accounts.length === 0) {
    checks.push({
      ok: false,
      label: "no account configured",
      detail:
        "Set BLUESKY_IDENTIFIER to your full handle and BLUESKY_APP_PASSWORD to an app password from bsky.app/settings/app-passwords. Public reads work without this; everything else does not.",
    });
    process.stdout.write(checks.map(line).join("\n") + "\n");
    return 1;
  }

  checks.push({
    ok: true,
    label: `${config.accounts.length} account${config.accounts.length === 1 ? "" : "s"} configured`,
    detail: config.accounts.map((a) => `${a.handle} @ ${a.service}`).join(", "),
  });

  // 3. Do the credentials actually work, per account.
  for (const account of config.accounts) {
    try {
      const session = await client.session(account);
      checks.push({ ok: true, label: `${account.handle} authenticates`, detail: session.did });

      const profile = await client.call<{ postsCount?: number; followersCount?: number }>(
        account,
        "app.bsky.actor.getProfile",
        { query: { actor: session.did } },
      );
      checks.push({
        ok: true,
        label: `${account.handle} can read`,
        detail: `${profile.followersCount ?? 0} followers, ${profile.postsCount ?? 0} posts`,
      });

      // An app password with no write scope authenticates and then fails on the
      // first post. getServiceAuth is the cheapest call that needs real scope.
      try {
        await client.serviceAuth(account, config.videoServiceDid, "app.bsky.video.getUploadLimits", 60);
        checks.push({ ok: true, label: `${account.handle} can write` });
      } catch (error) {
        checks.push({
          ok: false,
          label: `${account.handle} may not be able to write`,
          detail: `${(error as Error).message} — if posting fails, regenerate the app password.`,
        });
      }
    } catch (error) {
      const detail =
        error instanceof AtpError && error.status === 401
          ? "Bluesky rejected these credentials. The usual cause is using the account password: create an app password at bsky.app/settings/app-passwords instead."
          : (error as Error).message;
      checks.push({ ok: false, label: `${account.handle} fails to authenticate`, detail });
    }
  }

  // 4. Anything that will surprise someone later.
  if (config.readOnly) {
    checks.push({ ok: true, label: "BLUESKY_READ_ONLY=1 — every write is hidden from the tool list" });
  }
  if (!config.allowDestructive) {
    checks.push({ ok: true, label: "BLUESKY_ALLOW_DESTRUCTIVE=0 — posting and deleting are blocked" });
  }
  if (config.preferred.length) {
    checks.push({ ok: true, label: `default account preference: ${config.preferred.join(", ")}` });
  }

  process.stdout.write(checks.map(line).join("\n") + "\n");
  return checks.every((c) => c.ok) ? 0 : 1;
}
