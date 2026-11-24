import * as v from 'valibot';
import {
  Count,
  Handle,
  LinkPreview,
  MessageId,
  Name,
  NoControl,
  NoControlText,
  PublicPresence,
  Repo,
  Timestamp,
  Tool,
} from './common';
import { Requests } from './server';

// Newline-delimited JSON over margind's Unix socket: the app and reporters send
// requests ({op}), margind sends pushes ({type}).

const Pid = v.pipe(v.number(), v.integer(), v.minValue(1));

export const ReporterEvent = v.object({
  tool: Tool,
  event: v.picklist(['start', 'prompt', 'stop', 'end', 'model']),
  sessionId: v.pipe(v.string(), v.regex(/^[A-Za-z0-9._-]{1,128}$/)),
  model: v.optional(v.pipe(v.string(), v.maxLength(80), NoControl)),
  // Local only: used to find the git remote, never sent.
  cwd: v.optional(v.pipe(v.string(), v.maxLength(4096), NoControl)),
  pid: v.optional(Pid),
});
export type ReporterEvent = v.InferOutput<typeof ReporterEvent>;

export const Settings = v.object({
  invisible: v.boolean(),
  share: v.object({
    tool: v.boolean(),
    model: v.boolean(),
    repo: v.boolean(),
    time: v.boolean(),
    tokens: v.boolean(),
    prompts: v.boolean(),
  }),
  repos: v.record(Repo, v.picklist(['hidden', 'private'])),
  // "close": only closeFriends see activity; everyone else sees online/idle.
  audience: v.picklist(['everyone', 'close']),
  closeFriends: v.array(Handle),
  // Others on Margin can find you in Find friends.
  findable: v.boolean(),
  // Tell friends when you've read their messages; off also hides when they've read yours.
  readReceipts: v.boolean(),
  // Fetch a preview of links you send (on this Mac) and send it with the message.
  linkPreviews: v.boolean(),
});
export type Settings = v.InferOutput<typeof Settings>;

export const DEFAULT_SETTINGS: Settings = {
  invisible: false,
  share: { tool: true, model: true, repo: true, time: true, tokens: true, prompts: true },
  repos: {},
  audience: 'everyone',
  closeFriends: [],
  findable: true,
  readReceipts: true,
  linkPreviews: true,
};

export const ChatText = v.pipe(v.string(), v.minLength(1), v.maxLength(4000), NoControlText);

const HandleOp = <T extends string>(op: T) => v.object({ op: v.literal(op), handle: Handle });

export const Request = v.variant('op', [
  v.object({ op: v.literal('event'), event: ReporterEvent }),
  // The app gives its pid, so margind can tell when its main thread stops answering.
  v.object({ op: v.literal('subscribe'), pid: v.optional(Pid) }),
  v.object({ op: v.literal('ping') }),
  // The app's answer to a ping push, sent from its main thread, with what it was showing.
  v.object({
    op: v.literal('pong'),
    n: Count,
    menuBar: v.optional(v.boolean()),
    expanded: v.optional(v.boolean()),
    // An alert is up (it blocks the drawer), and whether any of it is on screen.
    modal: v.optional(v.boolean()),
    modalHidden: v.optional(v.boolean()),
  }),
  // Quitting or relaunching for an update: not a hang.
  v.object({ op: v.literal('app.quitting') }),
  // Crash and error reports waiting on this Mac: send them, throw them away, or show exactly
  // what would be sent.
  v.object({ op: v.literal('reports.send') }),
  v.object({ op: v.literal('reports.discard') }),
  v.object({ op: v.literal('reports.list') }),
  v.object({ op: v.literal('login') }),
  v.object({ op: v.literal('logout') }),
  v.object({ op: v.literal('send'), to: Handle, text: ChatText }),
  // A nudge: at most one to each friend every 45 seconds.
  v.object({ op: v.literal('nudge'), to: Handle }),
  // Delete a message from this Mac; Undo Send one of yours (within a day) for both of you;
  // delete a whole conversation from this Mac.
  v.object({ op: v.literal('delete'), id: MessageId }),
  v.object({ op: v.literal('unsend'), id: MessageId }),
  // Try Again on a message the server refused.
  v.object({ op: v.literal('retry'), id: MessageId }),
  // The preview the app fetched for a link in a message you just sent `to` someone.
  v.object({ op: v.literal('preview'), to: Handle, preview: LinkPreview }),
  v.object({
    op: v.literal('history'),
    with: Handle,
    before: v.optional(Timestamp),
    limit: v.optional(v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(200))),
    // Opens the chat at this message (a search result) instead of the latest page.
    around: v.optional(MessageId),
  }),
  // Messages on this Mac containing `query`, for search on the Chats tab. Never leaves the Mac.
  v.object({
    op: v.literal('search'),
    query: v.pipe(v.string(), v.minLength(1), v.maxLength(100), NoControlText),
  }),
  HandleOp('read'),
  HandleOp('chat.delete'),
  HandleOp('friend.request'),
  HandleOp('friend.accept'),
  HandleOp('friend.decline'),
  HandleOp('friend.remove'),
  HandleOp('block'),
  HandleOp('unblock'),
  // The safety number to compare with a friend, in person or on a call.
  HandleOp('safety'),
  v.object({ op: v.literal('blocks') }),
  v.object({
    op: v.literal('directory'),
    query: v.optional(v.pipe(v.string(), v.maxLength(40), NoControl)),
  }),
  v.object({
    op: v.literal('report'),
    handle: Handle,
    reason: v.pipe(v.string(), v.maxLength(500)),
  }),
  // Any subset, down to single sharing switches; an app older than a switch leaves it alone.
  v.object({
    op: v.literal('settings.set'),
    settings: v.partial(
      v.object({ ...Settings.entries, share: v.partial(Settings.entries.share) }),
    ),
  }),
  v.object({ op: v.literal('tools.connect'), tool: Tool }),
  v.object({ op: v.literal('tools.disconnect'), tool: Tool }),
  v.object({ op: v.literal('account.export') }),
  v.object({ op: v.literal('account.delete') }),
]);
export type Request = v.InferOutput<typeof Request>;

export const Friend = v.object({
  handle: Handle,
  name: v.optional(Name),
  presence: PublicPresence,
  lastSeenAt: Timestamp,
  unread: Count,
});
export type Friend = v.InferOutput<typeof Friend>;

export const ChatMessage = v.object({
  id: MessageId,
  peer: Handle,
  direction: v.picklist(['in', 'out']),
  // Empty once unsent.
  text: v.union([ChatText, v.literal('')]),
  sentAt: Timestamp,
  // Outgoing: "queued" until the server has it, "delivered" once it's on their Mac, "read"
  // once they've opened the chat (if they send read receipts), "failed" if the server refused
  // it. Either way: "unsent" once Undo Send removed it.
  state: v.optional(v.picklist(['queued', 'sent', 'delivered', 'read', 'unsent', 'failed'])),
  readAt: v.optional(Timestamp),
  preview: v.optional(LinkPreview),
  // A nudge (its text is empty).
  kind: v.optional(v.literal('nudge')),
});
export type ChatMessage = v.InferOutput<typeof ChatMessage>;

export const Push = v.variant('type', [
  v.object({
    type: v.literal('self'),
    handle: v.optional(Handle),
    name: v.optional(Name),
    // What close friends see (everyone, without close friends), and what everyone else sees.
    presence: v.optional(PublicPresence),
    basic: v.optional(PublicPresence),
    tokens: Count,
    connection: v.picklist(['signed-out', 'connecting', 'online', 'offline', 'update-required']),
    protocol: v.number(),
  }),
  v.variant('state', [
    v.object({
      type: v.literal('login'),
      state: v.literal('code'),
      userCode: v.string(),
      verificationUri: v.pipe(v.string(), v.url()),
    }),
    v.object({ type: v.literal('login'), state: v.literal('done') }),
    v.object({ type: v.literal('login'), state: v.literal('failed'), error: v.string() }),
    // Signed out because the account signed in on another Mac.
    v.object({ type: v.literal('login'), state: v.literal('elsewhere') }),
  ]),
  v.object({ type: v.literal('settings'), settings: Settings }),
  // How many reports are waiting, whether one is a crash (the app asks after a crash), and
  // when the oldest was kept (the app asks about errors once they've waited a while).
  v.object({
    type: v.literal('reports'),
    count: Count,
    crash: v.boolean(),
    since: v.optional(Timestamp),
  }),
  // Answered with a pong from the app's main thread (hang detection).
  v.object({ type: v.literal('ping'), n: Count }),
  v.object({
    type: v.literal('tools'),
    tools: v.array(v.object({ tool: Tool, found: v.boolean(), connected: v.boolean() })),
  }),
  v.object({ type: v.literal('roster'), friends: v.array(Friend) }),
  v.object({ type: v.literal('requests'), requests: Requests }),
  v.object({ type: v.literal('message'), message: ChatMessage }),
  v.object({ type: v.literal('history'), with: Handle, messages: v.array(ChatMessage) }),
  // The newest message in each chat, most recent first.
  v.object({ type: v.literal('chats'), chats: v.array(ChatMessage) }),
  v.object({
    type: v.literal('result'),
    op: v.string(),
    ok: v.boolean(),
    data: v.optional(v.unknown()),
    error: v.optional(v.string()),
  }),
]);
export type Push = v.InferOutput<typeof Push>;
