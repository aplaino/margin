import * as v from 'valibot';
import { Ciphertext, Count, Handle, MessageId, PublicPresence, Timestamp } from './common';

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

export const Requests = v.object({ incoming: v.array(Handle), outgoing: v.array(Handle) });
export type Requests = v.InferOutput<typeof Requests>;

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
  v.object({ t: v.literal('friends-changed') }),
  v.object({ t: v.literal('prekeys-low'), remaining: Count }),
  v.object({ t: v.literal('error'), error: v.pipe(v.string(), v.maxLength(200)) }),
]);
export type ServerFrame = v.InferOutput<typeof ServerFrame>;
