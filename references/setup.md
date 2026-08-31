# Bluesky MCP setup

Bluesky has a real, documented, public API. There is no OAuth app to register
and no developer account to apply for: a handle plus an app password is the
whole credential.

Most reads work with **no credentials at all**, against
`public.api.bsky.app`. Only `search_posts`, your own timeline, notifications
and every write need a session.

## Prerequisites

Node 20 or newer. Nothing else.

## Install

```bash
claude mcp add bluesky \
  -e BLUESKY_IDENTIFIER=you.bsky.social \
  -e BLUESKY_APP_PASSWORD=xxxx-xxxx-xxxx-xxxx \
  -- npx -y @thenavidm/bluesky-mcp
```

Or in any client's MCP config:

```json
{
  "mcpServers": {
    "bluesky": {
      "command": "npx",
      "args": ["-y", "@thenavidm/bluesky-mcp"],
      "env": {
        "BLUESKY_IDENTIFIER": "you.bsky.social",
        "BLUESKY_APP_PASSWORD": "xxxx-xxxx-xxxx-xxxx"
      }
    }
  }
}
```

## Getting an app password

1. [bsky.app/settings/app-passwords](https://bsky.app/settings/app-passwords)
2. **Add App Password**, name it `mcp`
3. Copy the `xxxx-xxxx-xxxx-xxxx` value. It is shown once

**Never use the account password.** An app password is revocable from that same
page and cannot change your email or password. The account password can.

## Several accounts

```bash
BLUESKY_ACCOUNTS='[
  {"handle":"you.bsky.social","app_password":"xxxx-xxxx-xxxx-xxxx"},
  {"handle":"brand.example.com","app_password":"yyyy-yyyy-yyyy-yyyy"}
]'
BLUESKY_DEFAULT_ACCOUNT=you.bsky.social
```

Every tool that acts as someone takes an optional `account`, matched against the
handle.

## Self-hosted PDS

```bash
BLUESKY_SERVICE_URL=https://your.pds
```

Or per account, as a `"service"` key inside `BLUESKY_ACCOUNTS`.

## Verify

```bash
npx -y @thenavidm/bluesky-mcp doctor
```

Checks the network, then each account's credentials, then a real read and a
real write scope. Each failure names the fix rather than the status code.

## Turning writes off

```bash
BLUESKY_READ_ONLY=1        # every write disappears from the tool list
BLUESKY_ALLOW_DESTRUCTIVE=0 # keeps likes and follows, blocks posting and deleting
BLUESKY_AUDIT_LOG=~/.bluesky-mcp/writes.jsonl
```

## When it breaks

| Symptom | Cause |
|---|---|
| "Bluesky rejected the credentials" | Account password used instead of an app password |
| "No account resolves for …" | Handle missing its domain |
| 403 on `search_posts` | No connected account; that one endpoint needs a session |
| "will not run without confirm: true" | Working as intended, for public and irreversible actions |
