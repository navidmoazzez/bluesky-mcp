# Setup and accounts

Run `whoami` if you need to know which account you are acting as, or `list_accounts` when more than one is connected and the user has not said which they mean.

Most reads work with no credentials. `search_posts`, the timeline, notifications and every write need a connected account.

## From the shell

The same tools are shell commands, under the same names with dashes. Reach for
them to pipe, filter, script or schedule. Reach for the tools when you are
working inside a conversation.

```bash
bluesky-cli                             # every command, one line each
bluesky-cli get-profile bsky.app        # get_profile works too
bluesky-cli <command> --help            # what it takes
```

**`--json` does not make a read filterable.** Reading commands return the tagged
text, so `--json` wraps that text in a JSON string and `jq` has no fields to
reach. Writes and the account commands return real objects, so `jq` works there:

```bash
bluesky-cli list-accounts --json | jq -r '.accounts[].handle'
```

Exit codes, so a mistake can be told from a failure worth retrying:

| Code | Means |
|---|---|
| `0` | it worked |
| `1` | it failed: no credentials, a refused write, an API error, an unknown command |
| `2` | it was typed wrong: a missing required flag, a bad value, an unknown option |

Errors are JSON on stderr whichever code comes back, so one parse covers both.

The guards are the same code, not a copy: `--confirm` is the shell spelling of
`confirm: true`, and `BLUESKY_READ_ONLY=1` removes the write commands rather
than failing them.
