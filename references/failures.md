# When something fails

| Message | What to do |
|---|---|
| "will not run without confirm: true" | Confirm with the user, then retry with `confirm: true` |
| "Bluesky rejected the credentials" | They used their account password. Tell them to create an app password at bsky.app/settings/app-passwords |
| "No account resolves for …" | The handle is missing its domain |
| 403 on `search_posts` | No connected account |
| "Image is N MB; Bluesky's limit is 1MB" | Resize before retrying |
| "Post is N characters" | Use `create_thread` |

## When not to reach for this

It cannot see direct messages, private accounts, or anything from a blocked
account. It cannot search further back than Bluesky's own index reaches, which
is shallower than people expect.

`search_posts` is the one read that needs a connected account, because Bluesky's
public API refuses that endpoint without a session. Everything else reads fine
with no credentials.

Bluesky has no edit. A posted post can only be deleted and replaced, and the
delete does not pull it out of feeds that already have it.
