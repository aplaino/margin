import {
  type ChatMessage,
  type ClientFrame,
  CONTROL,
  Control,
  type Friend,
  type LinkPreview,
  type Push,
  type ServerFrame,
} from '@margin/protocol';
import * as v from 'valibot';
import type { Connection } from './connection';
import { DaemonError, log } from './errors';
import { changedKey, healable, type Signal } from './signal';
import type { Store } from './store';

// Messages and the encrypted controls that travel with them (Undo Send, receipts, link
// previews), the outbox that holds both until the server has them, and asking a friend to
// send again what couldn't be read.

// How long after sending a message you can still Undo Send.
const UNSEND_MS = 24 * 60 * 60_000;
// A preview follows its message within seconds; one arriving much later is refused.
const PREVIEW_MS = 10 * 60_000;

// The preview's address is a whole link in the text (not the start of a longer one) with no
// user name or password, so the card opens exactly what the message shows.
export function linkIn(text: string, url: string) {
  try {
    const parsed = new URL(url);
    if (parsed.username || parsed.password) return false;
  } catch {
    return false;
  }
  for (let i = text.indexOf(url); i >= 0; i = text.indexOf(url, i + 1)) {
    const before = text[i - 1] ?? '';
    const rest = text.slice(i + url.length);
    if (/^$|[\s("'<[]/.test(before) && /^$|^\s|^[.,!?;:)\]}>"']+(\s|$)/.test(rest)) return true;
  }
  return false;
}

// Only a JPEG picture is kept; anything else loses its picture, not the preview.
export function safePreview(preview: LinkPreview): LinkPreview {
  if (!preview.image) return preview;
  const bytes = Buffer.from(preview.image, 'base64');
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return preview;
  const { image: _dropped, ...rest } = preview;
  return rest;
}

// Received chat text keeps newlines, tabs and joiners; every other control or format character goes.
function cleanChat(text: string) {
  const cleaned = text.replace(CONTROL, (c) => ('\t\n‌‍'.includes(c) ? c : '')).slice(0, 4000);
  return cleaned.trim() ? cleaned : null;
}

export type ChatDeps = {
  store: Store;
  signal: Signal;
  connection: () => Connection | undefined;
  push: (value: Push) => void;
  problem: (what: string, e?: unknown) => void;
  roster: () => Friend[];
  syncFriends: () => Promise<void>;
  fetchBundle: (handle: string) => Promise<void>;
  // How long a message the server turned away for being too many waits before going again.
  retryMs?: number;
};

export function createChat({
  store,
  signal,
  connection,
  push,
  problem,
  roster,
  syncFriends,
  fetchBundle,
  retryMs,
}: ChatDeps) {
  // The latest message in each chat with a current friend, for the Chats tab; the app keeps
  // it current from message pushes.
  const chats = (): Push => ({
    type: 'chats',
    chats: store.latest().filter((m) => store.friend(m.peer)),
  });

  let retryTimer: ReturnType<typeof setTimeout> | undefined;
  function retryOutboxSoon() {
    if (retryTimer) return;
    retryTimer = setTimeout(() => {
      retryTimer = undefined;
      flushOutbox();
    }, retryMs ?? 30_000);
  }

  function flushOutbox() {
    for (const item of store.outbox()) {
      if (!connection()?.send(item.frame as ClientFrame)) return;
    }
  }

  async function onMessage(frame: Extract<ServerFrame, { t: 'message' }>) {
    const ack = () => connection()?.send({ t: 'ack', id: frame.id });
    if (store.hasMessage(frame.id)) return ack();
    if (!store.friend(frame.from)?.identityKey) await syncFriends().catch(() => {});
    if (!store.friend(frame.from)) return ack();
    let text: string | null;
    try {
      text = cleanChat(await signal.decrypt(frame.from, frame.ciphertext));
    } catch (e) {
      // From a new identity key: trusted if it's the key the server has for them now, then
      // the message is asked for again on a session with that key.
      const key = changedKey(e);
      if (key) {
        if (await keyNowTrusted(frame.from, key)) askToResend(frame.from, frame.id);
        return ack();
      }
      // Retrying this frame can't help, so it's dropped rather than jam the queue. A lost
      // session asks the sender to start a new one and send it again.
      problem('dropped a message that could not be decrypted', e);
      if (healable(e)) askToResend(frame.from, frame.id);
      return ack();
    }
    if (!text) return ack();
    const message: ChatMessage = {
      id: frame.id,
      peer: frame.from,
      direction: 'in',
      text,
      sentAt: frame.sentAt,
    };
    store.saveMessage(message);
    ack();
    push({ type: 'message', message });
    push({ type: 'roster', friends: roster() });
    sendReceipt(frame.from, { t: 'delivered', id: frame.id });
  }

  // A control from a friend: an Undo Send is honoured for their own message, if it was
  // asked for within a day of sending (a little longer, for clocks and slow delivery);
  // receipts mark your messages to them delivered or read, at the server's time.
  async function onControl(frame: Extract<ServerFrame, { t: 'control' }>) {
    const ack = () => connection()?.send({ t: 'ack', id: frame.id });
    if (!store.friend(frame.from)) return ack();
    let control: Control;
    try {
      control = v.parse(Control, JSON.parse(await signal.decrypt(frame.from, frame.ciphertext)));
    } catch (e) {
      problem('dropped a control that could not be read', e);
      return ack();
    }
    if (control.t === 'delivered') {
      if (store.delivered(frame.from, control.id)) chatChanged(frame.from, control.id);
      return ack();
    }
    // A preview is kept only for their own message, and only if its address is in the text,
    // so a card can't claim one site and open another.
    if (control.t === 'preview') {
      const original = store.message(control.id);
      if (
        original?.peer === frame.from &&
        original.direction === 'in' &&
        original.state !== 'unsent' &&
        !original.preview &&
        frame.sentAt - original.sentAt <= PREVIEW_MS &&
        linkIn(original.text, control.preview.url)
      ) {
        store.setPreview(control.id, safePreview(control.preview));
        chatChanged(frame.from, control.id);
      }
      return ack();
    }
    if (control.t === 'read') {
      if (store.readUpTo(frame.from, control.id, frame.sentAt)) chatChanged(frame.from);
      return ack();
    }
    const original = store.message(control.id);
    if (
      original?.peer === frame.from &&
      original.direction === 'in' &&
      original.state !== 'unsent' &&
      frame.sentAt - original.sentAt <= UNSEND_MS + 5 * 60_000
    ) {
      store.unsend(control.id);
      chatChanged(frame.from, control.id);
    }
    ack();
  }

  function onAccepted(id: string) {
    store.dequeue(id);
    store.setMessageState(id, 'sent');
    const message = store.message(id);
    if (message) push({ type: 'message', message });
  }

  function onRejected(id: string, error: string) {
    // Too many at once, or a friend's queue is full while they're away: it stays in the
    // outbox and goes again shortly. Anything else won't succeed by retrying.
    if (error === 'rate limited' || error === 'queue full') {
      retryOutboxSoon();
      return;
    }
    store.dequeue(id);
    log('the server refused a message');
  }

  // Receipts go out on their own, so none is sent while invisible: invisible looks exactly
  // like offline, and a receipt would say this Mac is here.
  function sendReceipt(to: string, control: Extract<Control, { t: 'delivered' | 'read' }>) {
    if (store.settings().invisible) return;
    sendControl(to, control).catch((e) => problem(`could not send a ${control.t} receipt`, e));
  }

  // The preview the app fetched for a link you just sent: kept on your newest message to them
  // with that link (from the last five minutes) and sent after it.
  async function attachPreview(to: string, preview: LinkPreview) {
    if (!store.settings().linkPreviews || !store.friend(to)) return;
    const message = store
      .history(to)
      .reverse()
      .find(
        (m) =>
          m.direction === 'out' &&
          m.state !== 'unsent' &&
          !m.preview &&
          linkIn(m.text, preview.url) &&
          Date.now() - m.sentAt < 5 * 60_000,
      );
    if (!message) return;
    const safe = safePreview(preview);
    await sendControl(to, { t: 'preview', id: message.id, preview: safe }, () =>
      store.setPreview(message.id, safe),
    );
    chatChanged(to, message.id);
  }

  // An encrypted instruction for a friend's margind, kept in the outbox like a message until
  // the server has it. `alongside` runs in the same transaction as queueing it.
  async function sendControl(to: string, control: Control, alongside?: () => void) {
    if (!signal.hasSession(to) && !store.bundle(to)) await fetchBundle(to);
    const ciphertext = await signal.encrypt(to, JSON.stringify(control), store.bundle(to));
    const frame: ClientFrame = {
      t: 'send',
      id: crypto.randomUUID(),
      to,
      ciphertext,
      control: true,
    };
    store.transaction(() => {
      alongside?.();
      store.enqueue(frame.id, to, frame);
    });
    connection()?.send(frame);
  }

  // The app redraws a changed message in place; the Chats tab and unread counts follow.
  function chatChanged(peer: string, id?: string) {
    const message = id ? store.message(id) : undefined;
    if (message) push({ type: 'message', message });
    else push({ type: 'history', with: peer, messages: store.history(peer) });
    push(chats());
    push({ type: 'roster', friends: roster() });
  }

  // Undo Send: tells the friend's margind to remove it too. One still waiting to leave this
  // Mac never goes.
  async function unsend(id: string) {
    const message = store.message(id);
    if (message?.direction !== 'out' || message.state === 'unsent') {
      throw new DaemonError('Only your own messages can be unsent');
    }
    if (Date.now() - message.sentAt > UNSEND_MS) {
      throw new DaemonError('Messages can only be unsent within 24 hours');
    }
    const to = message.peer;
    if (!store.friend(to)) throw new DaemonError(`${to} isn’t your friend`);
    store.dequeue(id);
    await sendControl(to, { t: 'unsend', id }, () => store.unsend(id));
    chatChanged(to, id);
  }

  // At most 20 resend requests a minute to each friend.
  const resendAsks = new Map<string, number[]>();
  function askToResend(from: string, id: string) {
    const now = Date.now();
    const recent = (resendAsks.get(from) ?? []).filter((t) => now - t < 60_000);
    if (recent.length >= 20) return;
    resendAsks.set(from, [...recent, now]);
    connection()?.send({ t: 'reset', to: from, id });
  }

  // A friend couldn't read one of your messages: start a new session from fresh keys (once,
  // however many messages they ask about) and send that message again.
  const lastReset = new Map<string, number>();
  async function onReset(from: string, id: string) {
    if (!store.friend(from)) return;
    const now = Date.now();
    if (now - (lastReset.get(from) ?? 0) > 60_000) {
      lastReset.set(from, now);
      store.removeSignalSessions(from);
      await fetchBundle(from);
    }
    const original = store.message(id);
    if (original?.direction !== 'out' || original.state === 'unsent') return;
    if (original.peer !== from || !store.bundle(from)) return;
    const ciphertext = await signal.encrypt(from, original.text, store.bundle(from));
    // A new id: the server has already delivered the old one. The chat keeps the original.
    const frame: ClientFrame = { t: 'send', id: crypto.randomUUID(), to: from, ciphertext };
    store.enqueue(frame.id, from, frame);
    connection()?.send(frame);
  }

  // Checks a key a message arrived with against the server's current one, at most once a
  // minute per friend (each check uses up one of their prekeys).
  const lastKeyCheck = new Map<string, number>();
  async function keyNowTrusted(handle: string, key: string) {
    const now = Date.now();
    if (now - (lastKeyCheck.get(handle) ?? 0) > 60_000) {
      lastKeyCheck.set(handle, now);
      await fetchBundle(handle).catch((e) => problem('could not check a friend’s new keys', e));
    }
    return store.friend(handle)?.identityKey === key;
  }

  async function send(to: string, text: string) {
    if (!store.friend(to)) throw new DaemonError(`${to} isn’t your friend`);
    if (!signal.hasSession(to) && !store.bundle(to)) await fetchBundle(to);
    if (!signal.hasSession(to) && !store.bundle(to)) {
      throw new DaemonError(`${to} hasn’t finished setting up Margin yet`);
    }
    const ciphertext = await signal.encrypt(to, text, store.bundle(to));
    const message: ChatMessage = {
      id: crypto.randomUUID(),
      peer: to,
      direction: 'out',
      text,
      sentAt: Date.now(),
      state: 'queued',
    };
    const frame: ClientFrame = { t: 'send', id: message.id, to, ciphertext };
    store.transaction(() => {
      store.saveMessage(message);
      store.enqueue(message.id, to, frame);
    });
    push({ type: 'message', message });
    connection()?.send(frame);
    return message;
  }

  return {
    chats,
    flushOutbox,
    onMessage,
    onControl,
    onAccepted,
    onRejected,
    onReset,
    send,
    sendReceipt,
    attachPreview,
    unsend,
    chatChanged,
    stop() {
      clearTimeout(retryTimer);
    },
  };
}
