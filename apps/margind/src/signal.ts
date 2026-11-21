import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import type { Ciphertext, KeyBundle, PeerBundle } from '@margin/protocol';
import type { Store } from './store';

// libsignal (the JS port: X3DH + Double Ratchet) ships without types.
const require = createRequire(import.meta.url);
const {
  keyhelper,
  ProtocolAddress,
  SessionBuilder,
  SessionCipher,
  SessionRecord,
} = require('libsignal');

type KeyPair = { pubKey: Buffer; privKey: Buffer };
type Saved = {
  identity: { pub: string; priv: string };
  registrationId: number;
  signed: { keyId: number; pub: string; priv: string; signature: string };
};

export const PREKEY_BATCH = 50;
const b64 = (b: Buffer) => b.toString('base64');
const buf = (s: string) => Buffer.from(s, 'base64');

// 1:1 end-to-end encryption. Identity keys are pinned per friend in the store; a
// message from anyone presenting a different identity key is rejected.
export class Signal {
  private identity: KeyPair;
  private registrationId: number;
  private signed: { keyId: number; keyPair: KeyPair; signature: Buffer };

  constructor(private store: Store) {
    const saved = store.getJson<Saved>('signal:self');
    if (saved) {
      this.identity = { pubKey: buf(saved.identity.pub), privKey: buf(saved.identity.priv) };
      this.registrationId = saved.registrationId;
      this.signed = {
        keyId: saved.signed.keyId,
        keyPair: { pubKey: buf(saved.signed.pub), privKey: buf(saved.signed.priv) },
        signature: buf(saved.signed.signature),
      };
      return;
    }
    this.identity = keyhelper.generateIdentityKeyPair();
    this.registrationId = keyhelper.generateRegistrationId();
    this.signed = keyhelper.generateSignedPreKey(this.identity, 1);
    store.setJson('signal:self', {
      identity: { pub: b64(this.identity.pubKey), priv: b64(this.identity.privKey) },
      registrationId: this.registrationId,
      signed: {
        keyId: this.signed.keyId,
        pub: b64(this.signed.keyPair.pubKey),
        priv: b64(this.signed.keyPair.privKey),
        signature: b64(this.signed.signature),
      },
    } satisfies Saved);
    this.replenish();
  }

  identityKey() {
    return b64(this.identity.pubKey);
  }

  bundle(): KeyBundle {
    const preKeys = [];
    for (const id of this.store.preKeyIds()) {
      const pk = this.store.loadPreKey(id);
      if (pk) preKeys.push({ keyId: id, publicKey: b64(pk.pubKey) });
    }
    return {
      registrationId: this.registrationId,
      identityKey: this.identityKey(),
      signedPreKey: {
        keyId: this.signed.keyId,
        publicKey: b64(this.signed.keyPair.pubKey),
        signature: b64(this.signed.signature),
      },
      preKeys,
    };
  }

  // Fresh one-time prekeys, numbered after the highest ever used (used ones are deleted locally).
  replenish(count = PREKEY_BATCH) {
    const highest = Number(this.store.get('signal:maxPreKey')?.toString() ?? 0);
    const start = Math.max(highest, ...this.store.preKeyIds()) + 1;
    const preKeys = [];
    for (let id = start; id < start + count; id++) {
      const pk = keyhelper.generatePreKey(id);
      this.store.addPreKey(id, pk.keyPair.pubKey, pk.keyPair.privKey);
      preKeys.push({ keyId: id, publicKey: b64(pk.keyPair.pubKey) });
    }
    this.store.set('signal:maxPreKey', String(start + count - 1));
    return preKeys;
  }

  // Short fingerprint of both identity keys, for comparing in person.
  safetyNumber(peerIdentityKey: string): string {
    const keys = [this.identityKey(), peerIdentityKey].sort();
    const hash = createHash('sha256').update(keys.join('')).digest('hex');
    return (hash.slice(0, 20).match(/.{5}/g) ?? []).join(' ');
  }

  private storage() {
    const store = this.store;
    return {
      loadSession: async (id: string) => {
        const bytes = store.loadSignalSession(id);
        return bytes ? SessionRecord.deserialize(JSON.parse(bytes.toString())) : undefined;
      },
      // serialize() returns a plain object, not bytes.
      storeSession: async (id: string, record: { serialize(): object }) =>
        store.storeSignalSession(id, JSON.stringify(record.serialize())),
      // Called with "handle" or "handle.<deviceId>" depending on the code path.
      isTrustedIdentity: (address: string, key: Buffer) => {
        const pinned = store.friend(address.replace(/\.\d+$/, ''))?.identityKey;
        return pinned !== undefined && pinned === b64(key);
      },
      loadPreKey: async (id: number | string) => store.loadPreKey(Number(id)),
      removePreKey: (id: number) => store.removePreKey(id),
      loadSignedPreKey: () => this.signed.keyPair,
      getOurRegistrationId: () => this.registrationId,
      getOurIdentity: () => this.identity,
    };
  }

  hasSession(handle: string) {
    const bytes = this.store.loadSignalSession(`${handle}.1`);
    return !!bytes && SessionRecord.deserialize(JSON.parse(bytes.toString())).haveOpenSession();
  }

  // Starts a session from the friend's bundle the first time; after that the bundle isn't needed.
  async encrypt(handle: string, plaintext: string, bundle?: PeerBundle): Promise<Ciphertext> {
    const address = new ProtocolAddress(handle, 1);
    const storage = this.storage();
    if (!this.hasSession(handle)) {
      if (!bundle) throw new Error('no session and no bundle to start one');
      const preKey = bundle.preKeys[0];
      await new SessionBuilder(storage, address).initOutgoing({
        registrationId: bundle.registrationId,
        identityKey: buf(bundle.identityKey),
        signedPreKey: {
          keyId: bundle.signedPreKey.keyId,
          publicKey: buf(bundle.signedPreKey.publicKey),
          signature: buf(bundle.signedPreKey.signature),
        },
        ...(preKey ? { preKey: { keyId: preKey.keyId, publicKey: buf(preKey.publicKey) } } : {}),
      });
    }
    const message = await new SessionCipher(storage, address).encrypt(Buffer.from(plaintext));
    const body =
      typeof message.body === 'string'
        ? Buffer.from(message.body, 'binary')
        : Buffer.from(message.body);
    return { type: message.type as number, body: b64(body) };
  }

  async decrypt(from: string, ciphertext: Ciphertext): Promise<string> {
    const cipher = new SessionCipher(this.storage(), new ProtocolAddress(from, 1));
    const plain =
      ciphertext.type === 3
        ? await cipher.decryptPreKeyWhisperMessage(buf(ciphertext.body))
        : await cipher.decryptWhisperMessage(buf(ciphertext.body));
    return Buffer.from(plain).toString();
  }
}
