import { type Change, type GrepHit, type MemoryBackend, MemoryConflictError } from "../backend.ts";

const API = "https://api.github.com";
const BLOBS_PER_QUERY = 50;
const SNAPSHOTS_KEPT = 8;
const SHA = /^[0-9a-f]{40}$/;

export interface GitHubOptions {
  owner: string;
  repo: string;
  token: string;
  fetch?: typeof globalThis.fetch;
}

type Snapshot = Map<string, string>;

class GitHubError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export function githubBackend(options: GitHubOptions): MemoryBackend {
  const { owner, repo, token } = options;
  const fetchImpl = options.fetch ?? globalThis.fetch;
  const snapshots = new Map<string, Promise<Snapshot>>();

  async function request(path: string, init: RequestInit & { accept?: string } = {}): Promise<Response> {
    const response = await fetchImpl(`${API}${path}`, {
      ...init,
      headers: {
        authorization: `Bearer ${token}`,
        accept: init.accept ?? "application/vnd.github+json",
        "x-github-api-version": "2022-11-28",
        "user-agent": "engram",
        ...(init.body && { "content-type": "application/json" }),
      },
    });
    if (response.ok) return response;
    throw new GitHubError(response.status, `GitHub ${init.method ?? "GET"} ${path}: ${response.status} ${await response.text()}`);
  }

  async function rest<T>(path: string, init: RequestInit = {}): Promise<T> {
    return (await request(path, init)).json() as Promise<T>;
  }

  async function graphql<T>(query: string, variables: Record<string, unknown>): Promise<T> {
    const result = await rest<{ data?: T; errors?: { message: string; type?: string }[] }>("/graphql", {
      method: "POST",
      body: JSON.stringify({ query, variables }),
    });
    if (result.errors?.length) throw new GraphQLError(result.errors);
    return result.data as T;
  }

  const repoPath = `/repos/${owner}/${repo}`;

  async function head(branch: string): Promise<string | null> {
    try {
      return (await rest<{ object: { sha: string } }>(`${repoPath}/git/ref/heads/${encodePath(branch)}`)).object.sha;
    } catch (error) {
      // 409 is GitHub's answer for any ref of a repo with no commits yet.
      if (error instanceof GitHubError && (error.status === 404 || error.status === 409)) return null;
      throw error;
    }
  }

  async function resolve(ref: string): Promise<string | null> {
    return SHA.test(ref) ? ref : head(ref);
  }

  function snapshot(sha: string): Promise<Snapshot> {
    let pending = snapshots.get(sha);
    if (!pending) {
      pending = loadSnapshot(sha);
      pending.catch(() => snapshots.delete(sha));
      snapshots.set(sha, pending);
      if (snapshots.size > SNAPSHOTS_KEPT) snapshots.delete(snapshots.keys().next().value as string);
    }
    return pending;
  }

  async function loadSnapshot(sha: string): Promise<Snapshot> {
    const tree = await rest<{ tree: { path: string; type: string }[]; truncated: boolean }>(
      `${repoPath}/git/trees/${sha}?recursive=1`,
    );
    if (tree.truncated) throw new Error("Memory repo tree is too large to list in one request.");
    const paths = tree.tree.filter((entry) => entry.type === "blob").map((entry) => entry.path);
    const files: Snapshot = new Map();
    for (let start = 0; start < paths.length; start += BLOBS_PER_QUERY) {
      const batch = paths.slice(start, start + BLOBS_PER_QUERY);
      const fields = batch
        .map((path, at) => `f${at}: object(expression: ${JSON.stringify(`${sha}:${path}`)}) { ... on Blob { text isBinary } }`)
        .join("\n");
      const data = await graphql<{ repository: Record<string, { text: string | null; isBinary: boolean } | null> }>(
        `query($owner: String!, $repo: String!) { repository(owner: $owner, name: $repo) { ${fields} } }`,
        { owner, repo },
      );
      batch.forEach((path, at) => {
        const blob = data.repository[`f${at}`];
        if (blob && !blob.isBinary && blob.text !== null) files.set(path, blob.text);
      });
    }
    return files;
  }

  async function readFile(path: string, ref: string): Promise<string | null> {
    try {
      const response = await request(`${repoPath}/contents/${encodePath(path)}?ref=${encodeURIComponent(ref)}`, {
        accept: "application/vnd.github.raw+json",
      });
      return await response.text();
    } catch (error) {
      if (error instanceof GitHubError && (error.status === 404 || error.status === 409)) return null;
      throw error;
    }
  }

  async function createRef(branch: string, sha: string): Promise<void> {
    try {
      await rest(`${repoPath}/git/refs`, { method: "POST", body: JSON.stringify({ ref: `refs/heads/${branch}`, sha }) });
    } catch (error) {
      if (error instanceof GitHubError && error.status === 422) throw new MemoryConflictError(`${branch} already exists.`);
      throw error;
    }
  }

  async function commitOnBranch(change: Change, expectedHeadOid: string, put: Record<string, string>): Promise<string> {
    const [headline = "", ...body] = withTrailer(change).split("\n");
    try {
      const data = await graphql<{ createCommitOnBranch: { commit: { oid: string } } }>(
        `mutation($input: CreateCommitOnBranchInput!) { createCommitOnBranch(input: $input) { commit { oid } } }`,
        {
          input: {
            branch: { repositoryNameWithOwner: `${owner}/${repo}`, branchName: change.branch },
            expectedHeadOid,
            message: { headline, body: body.join("\n").trim() },
            fileChanges: {
              additions: Object.entries(put).map(([path, content]) => ({ path, contents: base64(content) })),
              deletions: (change.delete ?? []).map((path) => ({ path })),
            },
          },
        },
      );
      return data.createCommitOnBranch.commit.oid;
    } catch (error) {
      if (error instanceof GraphQLError && error.isStaleHead) throw new MemoryConflictError(error.message);
      throw error;
    }
  }

  async function rootCommit(change: Change): Promise<string> {
    try {
      const tree = await rest<{ sha: string }>(`${repoPath}/git/trees`, {
        method: "POST",
        body: JSON.stringify({
          tree: Object.entries(change.put).map(([path, content]) => ({ path, mode: "100644", type: "blob", content })),
        }),
      });
      const commit = await rest<{ sha: string }>(`${repoPath}/git/commits`, {
        method: "POST",
        body: JSON.stringify({ message: withTrailer(change), tree: tree.sha, parents: [] }),
      });
      await createRef(change.branch, commit.sha);
      return commit.sha;
    } catch (error) {
      if (error instanceof GitHubError && error.status === 409) return firstCommitOfEmptyRepo(change);
      throw error;
    }
  }

  // An empty repo rejects the git data API; only the contents API can make its first commit.
  async function firstCommitOfEmptyRepo(change: Change): Promise<string> {
    const [first, ...others] = Object.entries(change.put);
    if (!first) throw new Error("A first commit needs at least one file.");
    let sha: string;
    try {
      sha = (
        await rest<{ commit: { sha: string } }>(`${repoPath}/contents/${encodePath(first[0])}`, {
          method: "PUT",
          body: JSON.stringify({ message: withTrailer(change), content: base64(first[1]), branch: change.branch }),
        })
      ).commit.sha;
    } catch (error) {
      if (error instanceof GitHubError && error.status === 422) throw new MemoryConflictError(`${change.branch} was created meanwhile.`);
      throw error;
    }
    return others.length === 0 ? sha : commitOnBranch(change, sha, Object.fromEntries(others));
  }

  return {
    head,
    readFile,

    async listFiles(ref) {
      const sha = await resolve(ref);
      return sha ? [...(await snapshot(sha)).keys()] : [];
    },

    async grep(pattern, ref, limit) {
      const sha = await resolve(ref);
      if (!sha) return [];
      const matcher = new RegExp(pattern, "i");
      const hits: GrepHit[] = [];
      for (const [path, text] of await snapshot(sha)) {
        text.split("\n").forEach((line, at) => {
          if (hits.length < limit && matcher.test(line)) hits.push({ path, line: at + 1, text: line });
        });
      }
      return hits;
    },

    async commit(change) {
      if (change.expectedHeadSha !== null) return commitOnBranch(change, change.expectedHeadSha, change.put);
      if (!change.baseBranch) return rootCommit(change);
      const base = await head(change.baseBranch);
      if (!base) throw new Error(`Base branch ${change.baseBranch} does not exist.`);
      await createRef(change.branch, base);
      return commitOnBranch(change, base, change.put);
    },
  };
}

class GraphQLError extends Error {
  readonly isStaleHead: boolean;

  constructor(errors: { message: string; type?: string }[]) {
    super(errors.map((error) => error.message).join("; "));
    // GitHub reports a moved head two ways: STALE_DATA when it checks before writing, and a raw ref-lock
    // message when another commit lands while it writes.
    this.isStaleHead = errors.some(
      (error) =>
        error.type === "STALE_DATA" ||
        error.message.startsWith("Expected branch to point to") ||
        /is at [0-9a-f]{40} but expected [0-9a-f]{40}/.test(error.message),
    );
  }
}

function withTrailer(change: Change): string {
  return `${change.message}\n\nEngram-Client: ${change.author.name}`;
}

function base64(content: string): string {
  return Buffer.from(content, "utf8").toString("base64");
}

function encodePath(path: string): string {
  return path.split("/").map(encodeURIComponent).join("/");
}
