import { ApiError, GitStorage, RefUpdateError, type Repo } from "@pierre/storage";

import { type GrepHit, type MemoryBackend, MemoryConflictError } from "../backend.ts";

export interface CodeStorageOptions {
  name: string;
  repoId: string;
  key?: string;
  token?: string;
}

export function codeStorageRepo(options: CodeStorageOptions): Repo {
  const client = new GitStorage({
    name: options.name,
    ...(options.key && { key: options.key }),
    ...(options.token && { token: options.token }),
  });
  return client.repo({ id: options.repoId });
}

export function codeStorageBackend(repo: Repo): MemoryBackend {
  return {
    async head(branch) {
      try {
        const { commits } = await repo.listCommits({ branch, limit: 1 });
        return commits[0]?.sha ?? null;
      } catch (error) {
        if (isNotFound(error)) return null;
        throw error;
      }
    },

    async readFile(path, ref) {
      try {
        const response = await repo.getFileStream({ path, ref });
        if (response.status === 404) return null;
        if (!response.ok) throw new Error(`Reading ${path} at ${ref} failed with ${response.status}.`);
        return await response.text();
      } catch (error) {
        if (isNotFound(error)) return null;
        throw error;
      }
    },

    async listFiles(ref) {
      const paths: string[] = [];
      let cursor: string | undefined;
      do {
        const page = await repo.listFiles({ ref, recursive: true, ...(cursor && { cursor }) });
        paths.push(...page.entries.filter((entry) => entry.type === "blob").map((entry) => entry.path));
        cursor = page.hasMore ? page.nextCursor : undefined;
      } while (cursor);
      return paths;
    },

    async grep(pattern, ref, limit) {
      const result = await repo
        .grep({ ref, query: { pattern, caseSensitive: false }, limits: { maxLines: limit } })
        .catch((error: unknown) => {
          if (isNotFound(error)) return null;
          throw error;
        });
      if (result === null) return [];
      return result.matches
        .flatMap((file) =>
          file.lines.map((line): GrepHit => ({ path: file.path, line: line.lineNumber, text: line.text })),
        )
        .slice(0, limit);
    },

    async commit(change) {
      const builder = repo.createCommit({
        targetBranch: change.branch,
        commitMessage: change.message,
        author: change.author,
        // Code Storage cannot assert that a branch is absent, so creating one is unguarded; every later
        // write is compare-and-swap on the head it read.
        ...(change.expectedHeadSha !== null && { expectedHeadSha: change.expectedHeadSha }),
        ...(change.baseBranch && { baseBranch: change.baseBranch }),
      });
      for (const [path, content] of Object.entries(change.put)) builder.addFileFromString(path, content);
      for (const path of change.delete ?? []) builder.deletePath(path);
      try {
        return (await builder.send()).commitSha;
      } catch (error) {
        if (isConflict(error)) throw new MemoryConflictError(`${change.branch} moved since it was read.`);
        throw error;
      }
    },
  };
}

function isNotFound(error: unknown): boolean {
  return error instanceof ApiError && error.status === 404;
}

function isConflict(error: unknown): boolean {
  if (error instanceof RefUpdateError) return error.reason === "precondition_failed" || error.reason === "conflict";
  return error instanceof ApiError && (error.status === 409 || error.status === 412);
}
