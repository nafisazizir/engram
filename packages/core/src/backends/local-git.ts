import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { type Change, type GrepHit, type MemoryBackend, MemoryConflictError } from "../backend.ts";

const ZERO_SHA = "0".repeat(40);

interface GitResult {
  code: number;
  stdout: string;
  stderr: string;
}

export async function initLocalGitRepo(dir: string, branch = "main"): Promise<void> {
  await git(dir, ["init", "--quiet", "--bare", `--initial-branch=${branch}`], { gitDir: false });
}

export function localGitBackend(gitDir: string): MemoryBackend {
  const run = (args: string[], options: RunOptions = {}) => git(gitDir, args, options);

  return {
    async head(branch) {
      const result = await run(["rev-parse", "--verify", "--quiet", `refs/heads/${branch}^{commit}`], { allowFail: true });
      return result.code === 0 ? result.stdout.trim() : null;
    },

    async readFile(path, ref) {
      const result = await run(["cat-file", "blob", `${ref}:${path}`], { allowFail: true });
      return result.code === 0 ? result.stdout : null;
    },

    async listFiles(ref) {
      const result = await run(["ls-tree", "-r", "--name-only", "-z", ref], { allowFail: true });
      return result.code === 0 ? result.stdout.split("\0").filter(Boolean) : [];
    },

    async grep(pattern, ref, limit) {
      const result = await run(["grep", "-I", "-i", "-n", "-z", "-E", "-e", pattern, ref, "--"], { allowFail: true });
      if (result.code === 1) return [];
      if (result.code !== 0 && !(await refExists(run, ref))) return [];
      if (result.code !== 0) throw new Error(`Searching for ${pattern} failed: ${result.stderr.trim()}`);
      return result.stdout
        .split("\n")
        .filter(Boolean)
        .slice(0, limit)
        .map((row): GrepHit => {
          const [location = "", line = "0", text = ""] = row.split("\0");
          return { path: location.slice(ref.length + 1), line: Number(line), text };
        });
    },

    async commit(change) {
      return commitChange(run, change);
    },
  };
}

async function commitChange(run: Run, change: Change): Promise<string> {
  const parent = change.expectedHeadSha ?? (change.baseBranch ? await resolve(run, change.baseBranch) : null);
  const scratch = await mkdtemp(join(tmpdir(), "memory-index-"));
  const index = { GIT_INDEX_FILE: join(scratch, "index") };
  try {
    await run(parent ? ["read-tree", parent] : ["read-tree", "--empty"], { env: index });
    for (const [path, content] of Object.entries(change.put)) {
      const blob = (await run(["hash-object", "-w", "--stdin"], { input: content })).stdout.trim();
      await run(["update-index", "--add", "--cacheinfo", `100644,${blob},${path}`], { env: index });
    }
    for (const path of change.delete ?? []) {
      await run(["update-index", "--force-remove", "--", path], { env: index });
    }
    const tree = (await run(["write-tree"], { env: index })).stdout.trim();
    const identity = {
      GIT_AUTHOR_NAME: change.author.name,
      GIT_AUTHOR_EMAIL: change.author.email,
      GIT_COMMITTER_NAME: change.author.name,
      GIT_COMMITTER_EMAIL: change.author.email,
    };
    const commitArgs = ["commit-tree", tree, ...(parent ? ["-p", parent] : []), "-m", change.message];
    const sha = (await run(commitArgs, { env: identity })).stdout.trim();
    const expected = change.expectedHeadSha ?? ZERO_SHA;
    const update = await run(["update-ref", `refs/heads/${change.branch}`, sha, expected], { allowFail: true });
    if (update.code !== 0) throw new MemoryConflictError(`${change.branch} moved: ${update.stderr.trim()}`);
    return sha;
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

async function refExists(run: Run, ref: string): Promise<boolean> {
  return (await run(["rev-parse", "--verify", "--quiet", `${ref}^{commit}`], { allowFail: true })).code === 0;
}

async function resolve(run: Run, branch: string): Promise<string> {
  return (await run(["rev-parse", "--verify", `refs/heads/${branch}^{commit}`])).stdout.trim();
}

interface RunOptions {
  env?: Record<string, string>;
  input?: string;
  allowFail?: boolean;
  gitDir?: boolean;
}

type Run = (args: string[], options?: RunOptions) => Promise<GitResult>;

function git(gitDir: string, args: string[], options: RunOptions = {}): Promise<GitResult> {
  const fullArgs = options.gitDir === false ? [...args, gitDir] : ["--git-dir", gitDir, ...args];
  return new Promise((resolvePromise, reject) => {
    const child = execFile(
      "git",
      fullArgs,
      { env: { ...process.env, ...options.env }, maxBuffer: 64 * 1024 * 1024 },
      (error, stdout, stderr) => {
        const code = error ? (typeof error.code === "number" ? error.code : 1) : 0;
        if (code !== 0 && !options.allowFail) {
          reject(new Error(`git ${args[0]} failed: ${stderr.trim() || error?.message}`));
          return;
        }
        resolvePromise({ code, stdout, stderr });
      },
    );
    if (options.input !== undefined) child.stdin?.end(options.input);
  });
}
