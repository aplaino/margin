import { randomBytes } from 'node:crypto';

// The 32-byte key that encrypts margind's database lives in the macOS Keychain,
// never next to the database.
export type KeyProvider = (account: string) => Buffer;

const SERVICE = 'Margin';

function security(args: string[], stdin?: string) {
  const result = Bun.spawnSync(['security', ...args], {
    stdin: stdin === undefined ? undefined : new TextEncoder().encode(stdin),
    stderr: 'pipe',
  });
  return { ok: result.exitCode === 0, out: result.stdout.toString().trim() };
}

export const keychainKey: KeyProvider = (account) => {
  const existing = security(['find-generic-password', '-s', SERVICE, '-a', account, '-w']);
  if (existing.ok && /^[0-9a-f]{64}$/.test(existing.out)) return Buffer.from(existing.out, 'hex');
  const key = randomBytes(32);
  // Passed on stdin to `security -i` so the key never appears in a process listing.
  const saved = security(
    ['-i'],
    `add-generic-password -U -s ${SERVICE} -a "${account.replace(/["\\\n]/g, '')}" -w ${key.toString('hex')}\n`,
  );
  if (!saved.ok) throw new Error('could not save the database key in the Keychain');
  return key;
};

// Tests: a key per account, kept in memory.
export function memoryKeys(): KeyProvider {
  const keys = new Map<string, Buffer>();
  return (account) => {
    const key = keys.get(account) ?? randomBytes(32);
    keys.set(account, key);
    return key;
  };
}
