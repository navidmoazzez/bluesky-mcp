#!/usr/bin/env node
/**
 * Entry point.
 *
 * `bluesky-mcp`             stdio, which is what MCP clients launch
 * `bluesky-mcp --http`      HTTP, for running it somewhere always on
 * `bluesky-mcp <tool>`      run one tool from the shell, see cli.ts
 * `bluesky-mcp doctor`      check the setup and say what is wrong
 *
 * The shell surface is generated from the same `ALL_TOOLS` array the server
 * registers, so every tool is a command and neither surface can drift.
 */

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { buildServer, VERSION } from "./server.js";
import { loadConfig } from "./config.js";
import { httpOptionsFromEnv, startHttpServer } from "./transport/http.js";
import { isCliCommand, runCli } from "./cli.js";

const HELP = `bluesky-mcp ${VERSION}

  bluesky-mcp                     Run over stdio. This is what an MCP client launches.
  bluesky-mcp --http [--port=N]   Run over HTTP, for a machine that is always on.
  bluesky-mcp tools               List every tool as a shell command.
  bluesky-mcp <tool> [--flags]    Run one tool. Same names as the MCP surface.
  bluesky-mcp <tool> --help       What that tool takes.
  bluesky-mcp schema <tool>       The JSON schema an MCP client sees.
  bluesky-mcp doctor              Check the setup and report what is wrong.
  bluesky-mcp --version           Print the version.

  Every command prints JSON on --json, and errors as JSON on stderr.

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
  BLUESKY_MAX_RETRIES               retries on 429 and 5xx, default 3
  BLUESKY_USER_AGENT                sent on every request, default bluesky-mcp
  BLUESKY_HTTP_PORT / _HOST / _TOKEN  for --http

Endpoints. Defaults are Bluesky's own, so leave these alone unless you run your
own infrastructure. Reads go to the public API, which needs no credentials.

  BLUESKY_PUBLIC_API                default https://public.api.bsky.app
  BLUESKY_VIDEO_SERVICE             default https://video.bsky.app
  BLUESKY_VIDEO_SERVICE_DID         default did:web:video.bsky.app

https://github.com/thenavidm/bluesky-mcp-cli
`;

/**
 * Which name launched us.
 *
 * One file serves both binaries. `bluesky-mcp` with no arguments is an MCP
 * client starting a stdio server and must stay silent on stdout. `bluesky-cli`
 * with no arguments is a person who wants to know what they can type, so it
 * lists the commands instead of hanging on a transport that will never speak.
 */
function invokedAsCli(): boolean {
  const name = (process.argv[1] ?? "").split("/").pop() ?? "";
  return name.startsWith("bluesky-cli");
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const command = argv[0];

  if (invokedAsCli() && argv.length === 0) {
    process.exitCode = await runCli(["tools"]);
    return;
  }

  // Checked before --help and --version so `<tool> --help` reaches the tool.
  // A bare `--help` starts with a dash, so it falls through to the block below.
  if (isCliCommand(argv)) {
    process.exitCode = await runCli(argv);
    return;
  }

  // A word that is not a tool used to fall through and start the server, which
  // then sat waiting on stdin. Typing `bluesky-cli get-porfile` looked like a
  // hang rather than a typo, and scripts saw a success exit code.
  // `doctor` belongs to the entry point rather than the tool list, and it is
  // the first thing someone types when nothing works. Rejecting it as an
  // unknown command sent them to the server binary to diagnose the CLI.
  const ENTRY_COMMANDS = new Set(["doctor", "help"]);

  if (
    invokedAsCli() &&
    command !== undefined &&
    !command.startsWith("-") &&
    !ENTRY_COMMANDS.has(command)
  ) {
    process.stderr.write(
      `${JSON.stringify({ error: `Unknown command '${command}'. Run \`bluesky-cli\` to list them.` }, null, 2)}\n`,
    );
    process.exitCode = 1;
    return;
  }

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
