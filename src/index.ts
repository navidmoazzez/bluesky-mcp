#!/usr/bin/env node
/**
 * Entry point.
 *
 * `bluesky-mcp`             stdio, which is what MCP clients launch
 * `bluesky-mcp --http`      HTTP, for running it somewhere always on
 * `bluesky-mcp doctor`      check the setup and say what is wrong
 */

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { buildServer, VERSION } from "./server.js";
import { loadConfig } from "./config.js";
import { httpOptionsFromEnv, startHttpServer } from "./transport/http.js";

const HELP = `bluesky-mcp ${VERSION}

  bluesky-mcp                     Run over stdio. This is what an MCP client launches.
  bluesky-mcp --http [--port=N]   Run over HTTP, for a machine that is always on.
  bluesky-mcp doctor              Check the setup and report what is wrong.
  bluesky-mcp --version           Print the version.

Credentials, in priority order:
  BLUESKY_ACCOUNTS          JSON array, for several accounts at once:
                            [{"handle":"you.bsky.social","app_password":"xxxx-xxxx-xxxx-xxxx"}]
  BLUESKY_IDENTIFIER        your full handle, e.g. you.bsky.social
  BLUESKY_APP_PASSWORD      an app password from bsky.app/settings/app-passwords
  BLUESKY_SERVICE_URL       your PDS, default https://bsky.social

Options:
  BLUESKY_DEFAULT_ACCOUNT           which handle acts when a tool names none
  BLUESKY_READ_ONLY=1               hide every write from the tool list
  BLUESKY_ALLOW_DESTRUCTIVE=0       keep writes, block posting and deleting
  BLUESKY_REQUEST_TIMEOUT_MS        per-request deadline, default 30000
  BLUESKY_MIN_REQUEST_INTERVAL_MS   spacing between requests, default 120
  BLUESKY_AUDIT_LOG                 append-only log of every attempted write
  BLUESKY_HTTP_PORT / _HOST / _TOKEN  for --http

https://github.com/thenavidm/bluesky-mcp
`;

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const command = argv[0];

  if (argv.includes("--help") || argv.includes("-h") || command === "help") {
    process.stdout.write(HELP);
    return;
  }
  if (argv.includes("--version") || argv.includes("-v")) {
    process.stdout.write(`${VERSION}\n`);
    return;
  }
  if (command === "doctor") {
    const { runDoctor } = await import("./doctor.js");
    process.exitCode = await runDoctor();
    return;
  }

  const config = loadConfig();
  const built = buildServer(config);

  // Warn, never block. A network check at startup would delay the handshake,
  // and the failure is more actionable on the tool call that hits it.
  if (config.accounts.length === 0) {
    process.stderr.write(
      "[bluesky-mcp] No credentials configured. Public reads still work; anything that acts as you will report the missing setup. Run `bluesky-mcp doctor` for details.\n",
    );
  }

  const shutdown = async (close?: () => Promise<void>): Promise<void> => {
    if (close) await close().catch(() => undefined);
    process.exit(0);
  };

  if (argv.includes("--http")) {
    const { close } = await startHttpServer(built, httpOptionsFromEnv(argv));
    process.on("SIGTERM", () => void shutdown(close));
    process.on("SIGINT", () => void shutdown(close));
    return;
  }

  const transport = new StdioServerTransport();
  await built.server.connect(transport);

  // Handled so `docker stop` and a client shutting down return promptly rather
  // than waiting out a grace period.
  process.on("SIGTERM", () => void shutdown());
  process.on("SIGINT", () => void shutdown());
}

main().catch((error: unknown) => {
  process.stderr.write(`[bluesky-mcp] ${(error as Error).message}\n`);
  process.exit(1);
});
