import { z } from "zod";

import { clientsSchema } from "./clients.js";

const blankAsUnset = <T extends z.ZodType>(schema: T) => z.preprocess((value) => (value === "" ? undefined : value), schema);

const schema = z.object({
  GITHUB_TOKEN: z.string().min(1),
  MEMORY_REPO: z.string().regex(/^[\w.-]+\/[\w.-]+$/, "owner/name, e.g. nafisazizir/my-mem"),
  ENGRAM_CLIENTS: z
    .string()
    .min(1)
    .transform((value, ctx) => {
      try {
        return JSON.parse(value) as unknown;
      } catch {
        ctx.addIssue({ code: "custom", message: "must be JSON; generate entries with pnpm keygen" });
        return z.NEVER;
      }
    })
    .pipe(clientsSchema),
  GITHUB_WEBHOOK_SECRET: blankAsUnset(z.string().min(16).optional()),
});

export type Config = z.infer<typeof schema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = schema.safeParse(env);
  if (!parsed.success) throw new Error(`Invalid engram configuration:\n${z.prettifyError(parsed.error)}`);
  return parsed.data;
}
