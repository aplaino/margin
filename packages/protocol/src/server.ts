import * as v from 'valibot';
import {
  Ciphertext,
  Count,
  Handle,
  MessageId,
  Name,
  NoControl,
  NoControlText,
  PublicPresence,
  Timestamp,
} from './common';

const Base64Key = v.pipe(v.string(), v.base64(), v.maxLength(64));
const KeyId = v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(0xffffff));

export const PreKey = v.object({ keyId: KeyId, publicKey: Base64Key });

export const KeyBundle = v.object({
  registrationId: v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(16_380)),
  identityKey: Base64Key,
  signedPreKey: v.object({
    keyId: KeyId,
    publicKey: Base64Key,
    signature: v.pipe(v.string(), v.base64(), v.maxLength(128)),
  }),
  preKeys: v.pipe(v.array(PreKey), v.maxLength(200)),
});
export type KeyBundle = v.InferOutput<typeof KeyBundle>;

// A friend's bundle as handed out by the server, with at most one one-time prekey.
export const PeerBundle = v.object({ ...KeyBundle.entries, handle: Handle });
export type PeerBundle = v.InferOutput<typeof PeerBundle>;

export const Requests = v.object({ incoming: v.array(Handle), outgoing: v.array(Handle) });
export type Requests = v.InferOutput<typeof Requests>;

// Find friends: people on Margin who let themselves be found, minus friends, anyone who has
// blocked you and anyone you've blocked. `requested` is true when you've already asked.
export const Directory = v.object({
  people: v.pipe(
    v.array(v.object({ handle: Handle, name: v.optional(Name), requested: v.boolean() })),
    v.maxLength(100),
  ),
});
export type Directory = v.InferOutput<typeof Directory>;

export const Findable = v.object({ findable: v.boolean() });

// The handles you've blocked, for unblocking.
export const BlockList = v.object({ blocked: v.pipe(v.array(Handle), v.maxLength(10_000)) });
export type BlockList = v.InferOutput<typeof BlockList>;

// A crash or serious error, scrubbed on the Mac before it's sent. `install` is a random id
// per install, never tied to an account, so one Mac's reports can be told from many.
export const CrashReport = v.strictObject({
  install: v.pipe(v.string(), v.uuid()),
  version: v.pipe(v.string(), v.minLength(1), v.maxLength(40), NoControl),
  os: v.pipe(v.string(), v.maxLength(80), NoControl),
  component: v.picklist(['app', 'margind']),
  kind: v.picklist(['crash', 'error']),
  what: v.pipe(v.string(), v.minLength(1), v.maxLength(200), NoControl),
  detail: v.pipe(v.string(), v.maxLength(48_000), NoControlText),
  at: Timestamp,
});
export type CrashReport = v.InferOutput<typeof CrashReport>;

export const Config = v.object({ protocol: v.number(), githubClientId: v.nullable(v.string()) });
export type Config = v.InferOutput<typeof Config>;

export const Session = v.object({ token: v.string(), handle: Handle, name: v.optional(Name) });
export type Session = v.InferOutput<typeof Session>;

export const FriendList = v.object({
  friends: v.array(v.object({ handle: Handle, name: v.optional(Name) })),
});
export type FriendList = v.InferOutput<typeof FriendList>;

// margind → api over the WebSocket. The server sets the sender from the session.
export const ClientFrame = v.variant('t', [
  // `to` limits this view to those friends (close friends); without it, everyone else.
  v.object({
    t: v.literal('presence'),
    presence: PublicPresence,
    to: v.optional(v.pipe(v.array(Handle), v.maxLength(1000))),
  }),
  v.object({ t: v.literal('send'), id: MessageId, to: Handle, ciphertext: Ciphertext }),
  v.object({ t: v.literal('ack'), id: MessageId }),
]);
export type ClientFrame = v.InferOutput<typeof ClientFrame>;

// api → margind over the WebSocket.
export const ServerFrame = v.variant('t', [
  v.object({ t: v.literal('presence'), from: Handle, presence: PublicPresence }),
  v.object({
    t: v.literal('message'),
    id: MessageId,
    from: Handle,
    sentAt: Timestamp,
    ciphertext: Ciphertext,
  }),
  // The server has stored a sent message (it is now safe to drop from the outbox), or refused it.
  v.object({ t: v.literal('accepted'), id: MessageId }),
  v.object({
    t: v.literal('rejected'),
    id: MessageId,
    error: v.pipe(v.string(), v.maxLength(200)),
  }),
  v.object({ t: v.literal('friends-changed') }),
  v.object({ t: v.literal('prekeys-low'), remaining: Count }),
  v.object({ t: v.literal('error'), error: v.pipe(v.string(), v.maxLength(200)) }),
]);
export type ServerFrame = v.InferOutput<typeof ServerFrame>;
