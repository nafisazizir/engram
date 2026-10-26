import { cachedBackend, githubBackend } from "@nafisazizir/engram-core";
import { Hono } from "hono";

import { type Config, loadConfig } from "./config.js";
import { createApp } from "./routes.js";

function engram(config: Config) {
  const [owner = "", repo = ""] = config.MEMORY_REPO.split("/");
  return createApp({
    backend: cachedBackend(githubBackend({ owner, repo, token: config.GITHUB_TOKEN })),
    clients: config.ENGRAM_CLIENTS,
    readBranch: "main",
    ...(config.GITHUB_WEBHOOK_SECRET && { webhookSecret: config.GITHUB_WEBHOOK_SECRET }),
  });
}

// Vercel only accepts an entrypoint that imports hono itself.
const app = new Hono();

try {
  app.route("/", engram(loadConfig()));
} catch (error) {
  // A crash at startup shows only an opaque 500; naming the bad variable lets the deployer fix it.
  const message = error instanceof Error ? error.message : String(error);
  console.error(message);
  app.all("*", (c) => c.text(message, 500));
}

export default app;
