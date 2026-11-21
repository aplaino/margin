import * as v from 'valibot';
import { Count, Handle, MessageId, PublicPresence, Repo, Timestamp, Tool } from './common';
import { Requests } from './server';

// Newline-delimited JSON over margind's Unix socket: the app and reporters send
// requests ({op}), margind sends pushes ({type}).

// Control characters and bidi overrides can rewrite a terminal or disguise text in the drawer.
// biome-ignore lint/suspicious/noControlCharactersInRegex: rejecting control characters is the point
const NoControl = v.regex(/^[^\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]*$/);
// The same, but chat keeps newlines and tabs.
const NoControlText = v.regex(
  // biome-ignore lint/suspicious/noControlCharactersInRegex: rejecting control characters is the point
  /^[^\u0000-\u0008\u000b-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]*$/,
);

export const ReporterEvent = v.object({
  tool: Tool,
  event: v.picklist(['start', 'prompt', 'stop', 'end', 'model']),
  sessionId: v.pipe(v.string(), v.regex(/^[A-Za-z0-9._-]{1,128}$/)),
  model: v.optional(v.pipe(v.string(), v.maxLength(80), NoControl)),
  // Local only: used to find the git remote, never sent.
  cwd: v.optional(v.pipe(v.string(), v.maxLength(4096), NoControl)),
  pid: v.optional(v.pipe(v.number(), v.integer(), v.minValue(1))),
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
  }),
  repos: v.record(Repo, v.picklist(['hidden', 'private'])),
  // "close": only closeFriends see activity; everyone else sees online/idle.
  audience: v.picklist(['everyone', 'close']),
  closeFriends: v.array(Handle),
});
export type Settings = v.InferOutput<typeof Settings>;

export const DEFAULT_SETTINGS: Settings = {
  invisible: false,
  share: { tool: true, model: true, repo: true, time: true, tokens: true },
  repos: {},
  audience: 'everyone',
  closeFriends: [],
};

export const ChatText = v.pipe(v.string(), v.minLength(1), v.maxLength(4000), NoControlText);

const HandleOp = <T extends string>(op: T) => v.object({ op: v.literal(op), handle: Handle });

export const Request = v.variant('op', [
  v.object({ op: v.literal('event'), event: ReporterEvent }),
  v.object({ op: v.literal('subscribe') }),
  v.object({ op: v.literal('ping') }),
  v.object({ op: v.literal('login') }),
  v.object({ op: v.literal('logout') }),
  v.object({ op: v.literal('send'), to: Handle, text: ChatText }),
  v.object({
    op: v.literal('history'),
    with: Handle,
    before: v.optional(Timestamp),
    limit: v.optional(v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(200))),
  }),
  HandleOp('read'),
  HandleOp('friend.request'),
  HandleOp('friend.accept'),
  HandleOp('friend.decline'),
  HandleOp('friend.remove'),
  HandleOp('block'),
  v.object({
    op: v.literal('report'),
    handle: Handle,
    reason: v.pipe(v.string(), v.maxLength(500)),
  }),
  v.object({ op: v.literal('settings.set'), settings: v.partial(Settings) }),
  v.object({ op: v.literal('tools.connect'), tool: Tool }),
  v.object({ op: v.literal('tools.disconnect'), tool: Tool }),
  v.object({ op: v.literal('account.export') }),
  v.object({ op: v.literal('account.delete') }),
]);
export type Request = v.InferOutput<typeof Request>;

export const Friend = v.object({
  handle: Handle,
  presence: PublicPresence,
  lastSeenAt: Timestamp,
  unread: Count,
});
export type Friend = v.InferOutput<typeof Friend>;

export const ChatMessage = v.object({
  id: MessageId,
  peer: Handle,
  direction: v.picklist(['in', 'out']),
  text: ChatText,
  sentAt: Timestamp,
  // Outgoing only: "queued" until the server has it.
  state: v.optional(v.picklist(['queued', 'sent'])),
});
export type ChatMessage = v.InferOutput<typeof ChatMessage>;

export const Push = v.variant('type', [
  v.object({
    type: v.literal('self'),
    handle: v.optional(Handle),
    presence: v.optional(PublicPresence),
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
  ]),
  v.object({ type: v.literal('settings'), settings: Settings }),
  v.object({
    type: v.literal('tools'),
    tools: v.array(v.object({ tool: Tool, found: v.boolean(), connected: v.boolean() })),
  }),
  v.object({ type: v.literal('roster'), friends: v.array(Friend) }),
  v.object({ type: v.literal('requests'), requests: Requests }),
  v.object({ type: v.literal('message'), message: ChatMessage }),
  v.object({ type: v.literal('history'), with: Handle, messages: v.array(ChatMessage) }),
  v.object({
    type: v.literal('result'),
    op: v.string(),
    ok: v.boolean(),
    data: v.optional(v.unknown()),
    error: v.optional(v.string()),
  }),
]);
export type Push = v.InferOutput<typeof Push>;
