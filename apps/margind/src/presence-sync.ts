import {
  type Friend,
  PROTOCOL,
  type PublicPresence,
  type PublicStats,
  type Push,
  type ReporterEvent,
} from '@margin/protocol';
import type { Connection, ConnectionState } from './connection';
import {
  assertPublic,
  buildView,
  hiddenRepo,
  localSecrets,
  type PresenceView,
  shareable,
  withoutLocalDetails,
} from './presence';
import { originRepo, type repoClassifier } from './repo';
import type { LocalSession, Sessions } from './sessions';
import { Stats } from './stats';
import type { Store } from './store';
import { scanTokens, type TokenSources } from './tokens';

// Presence both ways: what friends see of you (recomputed and sent), and what they send
// of themselves (kept for the roster), plus the stats and token total that go into it.

const IDLE_AFTER_S = 5 * 60;
const STALE_MS = 90_000;

export type PresenceDeps = {
  store: Store;
  sessions: Sessions;
  classify: ReturnType<typeof repoClassifier>;
  idle: () => Promise<number>;
  tokenSources: TokenSources;
  connection: () => Connection | undefined;
  connectionState: () => ConnectionState | 'update-required';
  push: (value: Push) => void;
  problem: (what: string, e?: unknown) => void;
};

export function createPresence({
  store,
  sessions,
  classify,
  idle,
  tokenSources,
  connection,
  connectionState,
  push,
  problem,
}: PresenceDeps) {
  const friendPresence = new Map<string, { presence: PublicPresence; receivedAt: number }>();
  // When each friend was last online or idle, kept across restarts for the offline list.
  const lastSeen = new Map(
    Object.entries(store.getJson<Record<string, number>>('friendLastSeen') ?? {}),
  );
  let lastSeenSavedAt = 0;
  let view: PresenceView | undefined;
  let tokens = store.tokenTotal();
  const stats = new Stats(store);
  // The session you're working in (not idle), as of the last recompute; the heartbeat
  // counts it as time.
  let working: LocalSession | undefined;

  const savedTokens = () => store.getJson<Record<string, number>>('friendTokens') ?? {};
  const savedStats = () => store.getJson<Record<string, PublicStats>>('friendStats') ?? {};

  function roster(): Friend[] {
    const now = Date.now();
    const lastTokens = savedTokens();
    const lastStats = savedStats();
    return store.friends().map((f) => {
      const seen = friendPresence.get(f.handle);
      const fresh = seen && now - seen.receivedAt < STALE_MS;
      const known = seen?.presence.tokens ?? lastTokens[f.handle];
      const stats = lastStats[f.handle];
      // Offline, their last token total and stats stay (the profile says as of when).
      const kept = {
        ...(known !== undefined ? { tokens: known } : {}),
        ...(stats ? { stats } : {}),
      };
      const presence: PublicPresence = fresh
        ? { ...seen.presence, ...(seen.presence.status === 'offline' ? kept : {}) }
        : { status: 'offline', at: seen?.presence.at ?? 0, ...kept };
      return {
        handle: f.handle,
        ...(f.name ? { name: f.name } : {}),
        presence,
        lastSeenAt: lastSeen.get(f.handle) ?? 0,
        unread: store.unread(f.handle),
      };
    });
  }

  function selfPush(): Push {
    const a = store.account();
    return {
      type: 'self',
      ...(a ? { handle: a.handle } : {}),
      ...(a?.name ? { name: a.name } : {}),
      ...(view ? { presence: view.full, basic: view.basic } : {}),
      tokens,
      connection: !a ? 'signed-out' : connectionState(),
      protocol: PROTOCOL,
    };
  }

  // A prompt or new session counts toward stats unless you're invisible or it's in a repo
  // you've hidden, like time in a tool.
  async function countEvent(event: ReporterEvent, newSession: boolean) {
    const session = sessions
      .list()
      .find((s) => s.tool === event.tool && s.sessionId === event.sessionId);
    const remote = session?.cwd ? originRepo(session.cwd) : null;
    const settings = store.settings();
    if (settings.invisible || hiddenRepo(await classify(remote), remote, settings)) return;
    stats.event(event, newSession);
  }

  // What friends see, recomputed from sessions, settings, idle time and tokens.
  // Recalculations overlap (a heartbeat and a tool event, say); one that a newer one has
  // overtaken is dropped, so stale activity never overwrites fresh.
  let generation = 0;
  async function recompute() {
    const mine = ++generation;
    const settings = store.settings();
    const session = sessions.current();
    const status = (await idle()) > IDLE_AFTER_S ? 'idle' : 'online';
    const remote = session?.cwd ? originRepo(session.cwd) : null;
    const repo = session ? await classify(remote) : undefined;
    const activity =
      session && repo && !settings.invisible
        ? shareable(session, repo, remote, settings)
        : undefined;
    // Time while invisible or in a hidden repo isn't counted, so stats can't show it later.
    working =
      status === 'online' &&
      session &&
      repo &&
      !settings.invisible &&
      !hiddenRepo(repo, remote, settings)
        ? session
        : undefined;
    const recent = stats.view(tokens);
    let next = buildView({ status, activity, tokens, stats: recent, settings });
    const secrets = localSecrets(sessions.list());
    const full = withoutLocalDetails(next.full, secrets);
    const basic = withoutLocalDetails(next.basic, secrets);
    try {
      assertPublic(full, secrets);
      assertPublic(basic, secrets);
      next = { ...next, full, basic };
    } catch {
      // Fail closed: status, tokens and counts only, and without stats if even that fails.
      problem('withheld activity that failed the privacy check');
      const { model: _model, tool: _tool, ...counts } = recent;
      next = buildView({ status, tokens, stats: counts, settings });
      try {
        assertPublic(next.full, secrets);
        assertPublic(next.basic, secrets);
      } catch {
        next = buildView({ status, tokens, settings });
      }
    }
    if (mine !== generation) return;
    view = next;
    sendPresence();
    push(selfPush());
  }

  // Targeted view first, so close friends never flicker to the basic one.
  // Sent when it changes, and at least every 25 s so friends don't see you go stale (they
  // treat 90 s of silence as offline). The server caps how often presence may be sent.
  let lastSent = '';
  let lastSentAt = 0;
  let closeViewSent = false;
  function sendPresence(force = false) {
    const conn = connection();
    if (!view || !conn?.connected) return;
    const key = JSON.stringify({
      ...view,
      full: { ...view.full, at: 0 },
      basic: { ...view.basic, at: 0 },
    });
    if (!force && key === lastSent && Date.now() - lastSentAt < 25_000) return;
    lastSent = key;
    lastSentAt = Date.now();
    // An empty list ends the close-friends view (invisible, or close friends only turned off),
    // so close friends don't keep seeing the activity they saw before.
    if (view.close.length || closeViewSent) {
      conn.send({ t: 'presence', presence: view.full, to: view.close });
    }
    closeViewSent = view.close.length > 0;
    conn.send({ t: 'presence', presence: view.basic });
  }

  async function refreshTokens() {
    try {
      const next = await scanTokens(store, tokenSources);
      stats.tokens(next);
      if (next !== tokens) {
        tokens = next;
        await recompute();
      }
    } catch (e) {
      problem('token scan failed', e);
    }
  }

  async function onPresence(from: string, presence: PublicPresence) {
    if (!store.friend(from)) return;
    const now = Date.now();
    const before = friendPresence.get(from);
    friendPresence.set(from, { presence, receivedAt: now });
    // Online and idle say they were here; offline only marks the moment they left.
    const wasHere =
      before && before.presence.status !== 'offline' && now - before.receivedAt < STALE_MS;
    if (presence.status !== 'offline' || wasHere) {
      lastSeen.set(from, now);
      // Saved when they leave, and at most once a minute while they're here.
      if (presence.status === 'offline' || now - lastSeenSavedAt > 60_000) {
        store.setJson('friendLastSeen', Object.fromEntries(lastSeen));
        lastSeenSavedAt = now;
      }
    }
    // Going offline carries no count, so the last one is kept for the offline list. Online
    // without one means they've chosen to hide it, so it's forgotten.
    if (presence.status !== 'offline') {
      const { [from]: _, ...others } = savedTokens();
      store.setJson(
        'friendTokens',
        presence.tokens === undefined ? others : { ...others, [from]: presence.tokens },
      );
      const { [from]: _stats, ...otherStats } = savedStats();
      store.setJson(
        'friendStats',
        presence.stats === undefined ? otherStats : { ...otherStats, [from]: presence.stats },
      );
    }
    push({ type: 'roster', friends: roster() });
  }

  // A friend who's gone from the friend list.
  function forget(handle: string) {
    friendPresence.delete(handle);
    lastSeen.delete(handle);
  }

  // Signing out forgets everyone's presence.
  function forgetAll() {
    friendPresence.clear();
    lastSeen.clear();
    store.delete('friendLastSeen');
  }

  function heartbeat() {
    stats.tick(working, localSecrets(sessions.list()));
    sessions.expire();
    void recompute();
    push({ type: 'roster', friends: roster() });
  }

  return {
    roster,
    selfPush,
    countEvent,
    recompute,
    sendPresence,
    refreshTokens,
    onPresence,
    forget,
    forgetAll,
    heartbeat,
  };
}
