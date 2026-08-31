/** Which accounts are connected, and who the server is acting as. */

import { z } from "zod";
import { renderProfile } from "../format/posts.js";
import { accountArg, defineTool, type AnyToolSpec } from "./kit.js";

const listAccounts = defineTool({
  name: "list_accounts",
  title: "List connected accounts",
  description:
    "List every Bluesky account this server can act as. Use the handle from here as the `account` argument on any other tool. Call this first when the user has more than one account and has not said which one they mean.",
  schema: {},
  risk: "read",
  handler: async (_args, ctx) => ({
    count: ctx.client.accounts.length,
    default: ctx.client.accounts.length ? ctx.account().handle : null,
    accounts: ctx.client.accounts.map((a) => ({
      handle: a.handle,
      service: a.service,
      ...(a.did ? { did: a.did } : {}),
    })),
    ...(ctx.client.accounts.length === 0
      ? {
          note: "No credentials configured. Public reads still work; anything that acts as you will report the missing setup. Run `bluesky-mcp doctor`.",
        }
      : {}),
  }),
});

const whoami = defineTool({
  name: "whoami",
  title: "Verify credentials",
  description:
    "Authenticate and return the live profile for a connected account, including follower counts. Use this to confirm credentials work, or when the user says 'me' or 'my' and you need their handle and DID.",
  schema: { ...accountArg },
  risk: "read",
  handler: async ({ account }, ctx) => {
    const chosen = ctx.account(account);
    const session = await ctx.client.session(chosen);
    const profile = await ctx.client.call<Record<string, unknown>>(
      chosen,
      "app.bsky.actor.getProfile",
      { query: { actor: session.did } },
    );
    return renderProfile(profile);
  },
});

const videoJobStatus = defineTool({
  name: "get_video_job_status",
  title: "Check a video upload job",
  description:
    "Check a Bluesky video transcoding job by id. Only needed when create_post reported that a video was still processing when it gave up waiting — the job usually finishes on its own and the id is in that message.",
  schema: {
    job_id: z.string().describe("The job id reported by a timed-out create_post."),
    ...accountArg,
  },
  risk: "read",
  handler: async ({ job_id, account }, ctx) => {
    const chosen = ctx.account(account);
    const token = await ctx.client.serviceAuth(
      chosen,
      ctx.config.videoServiceDid,
      "app.bsky.video.getJobStatus",
    );
    return ctx.client.call(chosen, "app.bsky.video.getJobStatus", {
      service: ctx.config.videoService,
      token,
      query: { jobId: job_id },
    });
  },
});

export const accountTools: AnyToolSpec[] = [
  listAccounts as AnyToolSpec,
  whoami as AnyToolSpec,
  videoJobStatus as AnyToolSpec,
];
