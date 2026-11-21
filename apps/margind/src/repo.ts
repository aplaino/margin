import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { Repo } from '@margin/protocol';
import * as v from 'valibot';

export type RepoInfo = { visibility: 'public'; repo: string } | { visibility: 'private' };
export type FetchRepo = (repo: string) => Promise<{ private?: boolean; full_name?: string } | null>;

const TTL_MS = 6 * 60 * 60 * 1000;

function gitConfig(cwd: string): string | null {
  for (let dir = cwd; ; dir = dirname(dir)) {
    const git = join(dir, '.git');
    if (existsSync(git)) {
      // Worktrees and submodules use a .git file; treat them as unknown, so private.
      return statSync(git).isDirectory() ? join(git, 'config') : null;
    }
    if (dirname(dir) === dir) return null;
  }
}

// "owner/name" of the origin remote if it's on GitHub. Reads .git/config as text and never
// runs git: an untrusted repo can configure commands that git would execute.
export function originRepo(cwd: string): string | null {
  const config = gitConfig(cwd);
  if (!config || !existsSync(config)) return null;
  const text = readFileSync(config, 'utf8');
  const url = text.match(/\[remote "origin"\][^[]*?url\s*=\s*(\S+)/)?.[1];
  // The host must be exactly github.com (https, ssh:// or scp-style git@github.com:).
  const github = url?.match(
    /^(?:(?:https?|ssh|git):\/\/(?:[^@/\s]*@)?(?:www\.)?github\.com(?::\d+)?\/|git@github\.com:)([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/,
  );
  const repo = github ? `${github[1]}/${github[2]}` : null;
  return repo && v.is(Repo, repo) ? repo : null;
}

const githubRepo: FetchRepo = async (repo) => {
  const response = await fetch(`https://api.github.com/repos/${repo}`, {
    headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'margin' },
    signal: AbortSignal.timeout(5000),
  });
  return response.ok
    ? ((await response.json()) as { private?: boolean; full_name?: string })
    : null;
};

// Anything GitHub doesn't positively confirm as public is private.
export function repoClassifier(fetchRepo: FetchRepo = githubRepo) {
  const cache = new Map<string, { info: RepoInfo; at: number }>();
  return async (repo: string | null): Promise<RepoInfo> => {
    if (!repo) return { visibility: 'private' };
    const hit = cache.get(repo);
    if (hit && Date.now() - hit.at < TTL_MS) return hit.info;
    let info: RepoInfo = { visibility: 'private' };
    try {
      const data = await fetchRepo(repo);
      if (data?.private === false && data.full_name && v.is(Repo, data.full_name)) {
        info = { visibility: 'public', repo: data.full_name };
      }
    } catch {
      return info; // network failure: private, and not cached
    }
    cache.set(repo, { info, at: Date.now() });
    return info;
  };
}
