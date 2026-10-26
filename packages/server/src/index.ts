import { cachedBackend, githubBackend } from "@nafisazizir/engram-core";
import { Hono } from "hono";

import { loadConfig } from "./config.js";
import { createApp } from "./routes.js";

const config = loadConfig();
const [owner = "", repo = ""] = config.MEMORY_REPO.split("/");

const engram = createApp({
  backend: cachedBackend(githubBackend({ owner, repo, token: config.GITHUB_TOKEN })),
  clients: config.ENGRAM_CLIENTS,
  readBranch: "main",
  ...(config.GITHUB_WEBHOOK_SECRET && { webhookSecret: config.GITHUB_WEBHOOK_SECRET }),
});

// Vercel only accepts an entrypoint that imports hono itself.
export default new Hono().route("/", engram);
