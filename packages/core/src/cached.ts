import { type GrepHit, type MemoryBackend, MemoryConflictError } from "./backend.ts";

const SHA = /^[0-9a-f]{40}$/;

export interface CachedBackendOptions {
  // How long a branch head is trusted without asking. Our own commits and `forgetHeads` refresh it sooner.
  headTtlMs?: number;
  maxEntries?: number;
  now?: () => number;
}

export interface CachedBackend extends MemoryBackend {
  forgetHeads(branch?: string): void;
}

export function cachedBackend(inner: MemoryBackend, options: CachedBackendOptions = {}): CachedBackend {
  const headTtlMs = options.headTtlMs ?? 10_000;
  const maxEntries = options.maxEntries ?? 500;
  const now = options.now ?? Date.now;
  const heads = new Map<string, { sha: string | null; at: number }>();
  const immutable = new Map<string, Promise<unknown>>();

  async function head(branch: string): Promise<string | null> {
    const cached = heads.get(branch);
    if (cached && now() - cached.at < headTtlMs) return cached.sha;
    const sha = await inner.head(branch);
    heads.set(branch, { sha, at: now() });
    return sha;
  }

  function remember<T>(key: string, load: () => Promise<T>): Promise<T> {
    let pending = immutable.get(key) as Promise<T> | undefined;
    if (!pending) {
      pending = load();
      pending.catch(() => immutable.delete(key));
      immutable.set(key, pending);
      if (immutable.size > maxEntries) immutable.delete(immutable.keys().next().value as string);
    }
    return pending;
  }

  async function atCommit<T>(ref: string, missing: T, key: string, load: (sha: string) => Promise<T>): Promise<T> {
    const sha = SHA.test(ref) ? ref : await head(ref);
    if (sha === null) return missing;
    return remember(`${key}@${sha}`, () => load(sha));
  }

  return {
    head,

    readFile: (path, ref) => atCommit(ref, null, `file:${path}`, (sha) => inner.readFile(path, sha)),

    listFiles: (ref) => atCommit(ref, [], "list", (sha) => inner.listFiles(sha)),

    grep: (pattern, ref, limit) =>
      atCommit<GrepHit[]>(ref, [], `grep:${limit}:${pattern}`, (sha) => inner.grep(pattern, sha, limit)),

    async commit(change) {
      try {
        const sha = await inner.commit(change);
        heads.set(change.branch, { sha, at: now() });
        return sha;
      } catch (error) {
        if (MemoryConflictError.is(error)) heads.delete(change.branch);
        throw error;
      }
    },

    forgetHeads(branch) {
      if (branch === undefined) heads.clear();
      else heads.delete(branch);
    },
  };
}
