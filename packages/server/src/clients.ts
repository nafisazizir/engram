import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

import { z } from "zod";

export interface Client {
  name: string;
  // null makes the client read-only.
  writeBranch: string | null;
}

const clientSchema = z.object({
  name: z.string().regex(/^[a-z0-9][a-z0-9-]*$/, "lowercase letters, digits and dashes"),
  keySha256: z.string().regex(/^[0-9a-f]{64}$/),
  writeBranch: z.string().min(1).nullable(),
});

export const clientsSchema = z.array(clientSchema).refine(
  (clients) => new Set(clients.map((client) => client.name)).size === clients.length,
  "client names must be unique",
);

export type ClientConfig = z.infer<typeof clientSchema>;

export function hashKey(key: string): string {
  return createHash("sha256").update(key).digest("hex");
}

export function newKey(): string {
  return `engram_${randomBytes(32).toString("base64url")}`;
}

export function authenticate(clients: readonly ClientConfig[], authorization: string | undefined): Client | null {
  const key = /^Bearer (\S+)$/.exec(authorization ?? "")?.[1];
  if (!key) return null;
  const presented = Buffer.from(hashKey(key), "hex");
  const match = clients.find((client) => timingSafeEqual(presented, Buffer.from(client.keySha256, "hex")));
  return match ? { name: match.name, writeBranch: match.writeBranch } : null;
}
