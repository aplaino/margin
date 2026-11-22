import {
  type Handle,
  Model,
  type PublicActivity,
  PublicPresence,
  type PublicStats,
  type Settings,
  type Status,
} from '@margin/protocol';
import * as v from 'valibot';
import type { RepoInfo } from './repo';
import type { LocalSession } from './sessions';

// What friends see: `full` goes to the handles in `close`, `basic` to everyone else.
export type PresenceView = { full: PublicPresence; basic: PublicPresence; close: Handle[] };

// Tool model names can carry suffixes like "[1m]"; keep the plain name or nothing.
// Providers whose "provider/model" prefix is safe to show. Any other prefix could be a
// name you chose (a local model server, a company proxy), so only the model part is kept.
const PROVIDERS = new Set([
  'anthropic',
  'openai',
  'google',
  'openrouter',
  'github-copilot',
  'amazon-bedrock',
  'azure',
  'mistral',
  'groq',
  'xai',
  'deepseek',
]);

// Tool model names can carry suffixes like "[1m]"; keep the plain name or nothing.
export function publicModel(model?: string) {
  let cleaned = model?.replace(/\[[^\]]*\]$/, '').trim();
  const slash = cleaned?.lastIndexOf('/') ?? -1;
  if (
    cleaned &&
    slash >= 0 &&
    !PROVIDERS.has(cleaned.slice(0, cleaned.indexOf('/')).toLowerCase())
  ) {
    cleaned = cleaned.slice(slash + 1);
  }
  return cleaned && v.is(Model, cleaned) ? cleaned : undefined;
}

// A renamed or transferred repo has its old name in the git remote and its new one on
// GitHub; an override under either name applies, and "hidden" wins over "private".
function repoOverride(settings: Settings, names: (string | null)[]) {
  const wanted = new Set(names.filter((n): n is string => !!n).map((n) => n.toLowerCase()));
  const matches = Object.entries(settings.repos)
    .filter(([repo]) => wanted.has(repo.toLowerCase()))
    .map(([, value]) => value);
  return matches.includes('hidden') ? 'hidden' : matches[0];
}

const overrideFor = (repo: RepoInfo, remote: string | null, settings: Settings) =>
  repoOverride(settings, [remote, repo.visibility === 'public' ? repo.repo : null]);

// A session in a repo you've hidden: nothing about it reaches friends, not even in stats.
export const hiddenRepo = (repo: RepoInfo, remote: string | null, settings: Settings) =>
  overrideFor(repo, remote, settings) === 'hidden';

// The session as friends may see it, after the sharing settings. Undefined when nothing may be shown.
export function shareable(
  session: LocalSession,
  repo: RepoInfo,
  remote: string | null,
  settings: Settings,
): PublicActivity | undefined {
  const override = overrideFor(repo, remote, settings);
  if (override === 'hidden') return undefined;
  const activity: PublicActivity = {};
  if (settings.share.tool) activity.tool = session.tool;
  const model = publicModel(session.model);
  if (settings.share.model && model) activity.model = model;
  // A local model server has no folder, so there's no project to show.
  const local = session.tool === 'ollama' || session.tool === 'lm-studio';
  if (settings.share.repo && !local) {
    activity.project =
      override !== 'private' && repo.visibility === 'public'
        ? { visibility: 'public', repo: repo.repo }
        : { visibility: 'private' };
  }
  if (settings.share.time) activity.since = Math.floor(session.startedAt / 60_000) * 60_000;
  return Object.keys(activity).length ? activity : undefined;
}

export function buildView(input: {
  status: Status;
  activity?: PublicActivity;
  tokens: number;
  stats?: PublicStats;
  settings: Settings;
  now?: number;
}): PresenceView {
  const { settings, stats } = input;
  const at = input.now ?? Date.now();
  // Invisible looks exactly like being offline: no activity, no token count changes.
  if (settings.invisible) {
    const offline: PublicPresence = { status: 'offline', at };
    return { full: offline, basic: offline, close: [] };
  }
  const tokens = settings.share.tokens ? { tokens: input.tokens } : {};
  const pick = (on: boolean, keys: (keyof PublicStats)[]): PublicStats =>
    stats && on
      ? Object.fromEntries(keys.filter((k) => stats[k] !== undefined).map((k) => [k, stats[k]]))
      : {};
  // Token and prompt numbers reach everyone who sees your token total; the rest says more
  // about how you work, so it goes only where activity does.
  const counts = {
    ...pick(settings.share.tokens, ['today', 'week', 'daily']),
    ...pick(settings.share.prompts, ['promptsToday', 'promptsWeek', 'prompts']),
  };
  const all = {
    ...counts,
    ...pick(settings.share.time, ['minutes', 'days', 'sessions', 'longest']),
    ...pick(settings.share.tool, ['tool']),
    ...pick(settings.share.model, ['model']),
  };
  const full: PublicPresence = {
    status: input.status,
    ...(input.activity ? { activity: input.activity } : {}),
    ...tokens,
    ...(Object.keys(all).length ? { stats: all } : {}),
    at,
  };
  if (settings.audience === 'everyone') return { full, basic: full, close: [] };
  // Everyone else sees online/idle and token numbers, like the token total.
  const basic: PublicPresence = {
    status: input.status,
    ...tokens,
    ...(Object.keys(counts).length ? { stats: counts } : {}),
    at,
  };
  return { full, basic, close: settings.closeFriends };
}

export class LeakError extends Error {}

// Strings from this machine that must never appear in what's sent.
export function localSecrets(sessions: LocalSession[]) {
  return sessions
    .flatMap((s) => [s.cwd, ...(s.cwd?.split('/') ?? []), s.sessionId])
    .filter((s): s is string => !!s && s.length > 2);
}

// The last check before presence leaves the machine: exactly the public shape (nothing
// extra), and no local path or session id inside the one free-text field, the model.
// The public repo label is exempt: showing it is the point.
export function assertPublic(presence: PublicPresence, secrets: string[]) {
  const parsed = v.safeParse(PublicPresence, presence);
  if (!parsed.success || !Bun.deepEquals(parsed.output, presence, true)) {
    throw new LeakError('presence is not exactly the public shape');
  }
  for (const model of [presence.activity?.model, presence.stats?.model]) {
    const name = model?.toLowerCase() ?? '';
    const leaked = secrets.filter((s) => name.includes(s.toLowerCase()));
    if (leaked.length) throw new LeakError(`model name contains local details: ${leaked.length}`);
  }
}

export const isLocal = (model: string | undefined, secrets: string[]) =>
  !!model && secrets.some((s) => model.toLowerCase().includes(s.toLowerCase()));

// A model name that happens to match a local folder name loses the model, not the
// whole activity: a folder called "claude" shouldn't hide what you're doing.
export function withoutLocalDetails(presence: PublicPresence, secrets: string[]): PublicPresence {
  let out = presence;
  if (out.activity && isLocal(out.activity.model, secrets)) {
    const { model: _dropped, ...activity } = out.activity;
    out = { ...out, activity };
  }
  if (out.stats && isLocal(out.stats.model, secrets)) {
    const { model: _dropped, ...stats } = out.stats;
    out = { ...out, stats };
  }
  return out;
}
