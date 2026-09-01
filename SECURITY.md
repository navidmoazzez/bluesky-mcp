# Security

## Reporting a vulnerability

[Report it privately](https://github.com/navidmoazzez/bluesky-mcp/security/advisories/new).
Please do not open a public issue for a security problem: an issue is visible to
everyone the moment you file it, including whoever would use the bug.

Include what you did, what happened, and what you expected. A proof of concept
helps. Reporters are credited in the fix notes unless they would rather not be.

## What this server holds

**An app password**, in `BLUESKY_APP_PASSWORD`. Not your account password, and
that distinction is the whole point: an app password can be revoked on its own
from Bluesky's settings without changing your real password or touching any
other app.

Use one. Never put your account password in that variable. If you already have,
change your password and issue an app password instead.

**A session cache and an audit log**, in the data directory. The session is a
live credential, so treat that directory the way you would treat a password
manager file.

Nothing leaves your machine except calls to your PDS. No telemetry.

## Write safety

Writes work by default, because posting is the point of the server. A server
where every write needs a flag teaches the operator to set that flag
permanently, which is worse than no protection because it looks like protection.

Three graduated mechanisms instead:

**`confirm: true` on the operations that reach other people.** Posting, threads,
deleting, blocking. A post is public the instant it lands, and deleting it does
not pull it out of the feeds, caches and clients that already have it. There is
no unsend.

Likes, reposts, follows and mutes are not guarded. Each is one click to undo,
and confirming everything trains the model to pass `confirm` reflexively, which
is worse than not asking.

**`BLUESKY_READ_ONLY=1` removes every write from the tool list.** Not a refusal
at call time: the tools are never registered. A model cannot call a tool it
cannot see, and cannot argue with a refusal it never receives. This is the
setting for pointing an untrusted agent at an account.

**`BLUESKY_AUDIT_LOG=<path>` records every attempted write**, allowed and
blocked alike, one line each. The model has no tool to read or edit that file.

## Untrusted content

Posts, replies, quotes, display names and bios are written by other people.
Anything the timeline or a search returns is text a stranger chose, and
"summarise my notifications" is one of the first things anyone asks.

Treat that content as data to report on, never as instructions. The risk is
highest when writes are enabled, because a reply is a text field aimed at an
agent that can post.

## Running it over HTTP

The HTTP transport has no authentication of its own. It belongs behind TLS and
an authenticating reverse proxy.

Do not expose it directly. It holds a live credential for your account, and an
open endpoint hands it to anyone who finds it.

## Supported versions

The latest published version gets fixes. Given the size of this project, older
versions do not.
