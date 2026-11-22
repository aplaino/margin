import { describe, expect, test } from 'bun:test';
import * as v from 'valibot';
import {
  ClientFrame,
  Handle,
  PublicPresence,
  Push,
  ReporterEvent,
  Request,
  ServerFrame,
} from '../src';

const ok = (schema: v.GenericSchema, input: unknown) => v.safeParse(schema, input).success;

describe('Handle', () => {
  test('accepts GitHub logins', () => {
    for (const h of ['a', 'maya-chen', 'aplaino', 'a1-b2']) expect(ok(Handle, h)).toBe(true);
  });

  test('rejects anything that could escape a path or a terminal', () => {
    for (const h of ['', '-a', 'a-', 'Maya', '../x', 'a/b', 'a.b', 'a\u001b[2J', 'x'.repeat(40)]) {
      expect(ok(Handle, h)).toBe(false);
    }
  });
});

describe('PublicPresence', () => {
  test('drops fields that must never leave the machine', () => {
    const parsed = v.parse(PublicPresence, {
      status: 'online',
      at: 1,
      tokens: 48_100_000,
      cwd: '/Users/me/secret',
      activity: { tool: 'codex', branch: 'fix/leak', prompt: 'hi' },
    });
    expect(parsed).toEqual({
      status: 'online',
      at: 1,
      tokens: 48_100_000,
      activity: { tool: 'codex' },
    });
  });

  test('rejects a private repo smuggled in as public with a bad name', () => {
    const presence = {
      status: 'online',
      at: 1,
      activity: { project: { visibility: 'public', repo: '/Users/me/app' } },
    };
    expect(ok(PublicPresence, presence)).toBe(false);
  });

  test('a tool from a newer version is dropped, not the whole presence', () => {
    const parsed = v.parse(PublicPresence, {
      status: 'online',
      at: 1,
      activity: { tool: 'some-future-tool', model: 'qwen3-coder' },
    });
    expect(parsed.activity?.tool).toBeUndefined();
    expect(parsed.activity?.model).toBe('qwen3-coder');
  });

  test('rejects negative or fractional token counts', () => {
    expect(ok(PublicPresence, { status: 'idle', at: 1, tokens: -1 })).toBe(false);
    expect(ok(PublicPresence, { status: 'idle', at: 1, tokens: 1.5 })).toBe(false);
  });
});

describe('server frames', () => {
  const id = '0193a1e2-7c4b-7d2e-9f10-3a4b5c6d7e8f';

  test('parses each client frame', () => {
    expect(ok(ClientFrame, { t: 'presence', presence: { status: 'online', at: 1 } })).toBe(true);
    expect(
      ok(ClientFrame, { t: 'send', id, to: 'maya', ciphertext: { type: 3, body: 'AAEC' } }),
    ).toBe(true);
    expect(ok(ClientFrame, { t: 'ack', id })).toBe(true);
  });

  test('rejects non-base64 ciphertext and unknown frame types', () => {
    expect(
      ok(ClientFrame, { t: 'send', id, to: 'maya', ciphertext: { type: 1, body: 'not base64!' } }),
    ).toBe(false);
    expect(ok(ClientFrame, { t: 'shell', cmd: 'rm' })).toBe(false);
  });

  test('a server error is length-limited', () => {
    expect(ok(ServerFrame, { t: 'error', error: 'x'.repeat(201) })).toBe(false);
  });
});

describe('local protocol', () => {
  test('a reporter event keeps only whitelisted fields', () => {
    const parsed = v.parse(ReporterEvent, {
      tool: 'claude-code',
      event: 'prompt',
      sessionId: 'abc-123',
      prompt: 'my secret prompt',
      last_assistant_message: 'reply',
    });
    expect(parsed).toEqual({ tool: 'claude-code', event: 'prompt', sessionId: 'abc-123' });
  });

  test('rejects control characters in a model name', () => {
    const event = {
      tool: 'codex',
      event: 'model',
      sessionId: 's',
      model: 'gpt\u001b]0;pwned\u0007',
    };
    expect(ok(ReporterEvent, event)).toBe(false);
  });

  test('chat text is bounded', () => {
    expect(ok(Request, { op: 'send', to: 'maya', text: '' })).toBe(false);
    expect(ok(Request, { op: 'send', to: 'maya', text: 'x'.repeat(4001) })).toBe(false);
    expect(ok(Request, { op: 'send', to: 'maya', text: 'hey' })).toBe(true);
  });

  test('chat text keeps newlines but rejects escapes and bidi overrides', () => {
    expect(ok(Request, { op: 'send', to: 'maya', text: 'line one\n\tline two' })).toBe(true);
    const hidden = ['hi\u001b[2J', 'a\rb', 'pay \u202eyas', '\u2066x\u2069', 'x\u009b'];
    // Zero-width space, direction marks, Arabic letter mark, soft hyphen, BOM, line separator.
    hidden.push('a\u200bb', 'a\u200eb', 'a\u200fb', 'a\u061cb', 'a\u00adb', '\ufeffa', 'a\u2028b');
    for (const text of hidden) {
      expect(ok(Request, { op: 'send', to: 'maya', text })).toBe(false);
    }
  });

  test('chat keeps emoji sequences and joiners real scripts need', () => {
    for (const text of [
      '\u{1f469}\u200d\u{1f4bb} shipping',
      '\u0645\u06cc\u200c\u062e\u0648\u0627\u0647\u0645',
    ]) {
      expect(ok(Request, { op: 'send', to: 'maya', text })).toBe(true);
    }
  });

  test('login pushes are told apart by state', () => {
    expect(ok(Push, { type: 'login', state: 'done' })).toBe(true);
    expect(
      ok(Push, {
        type: 'login',
        state: 'code',
        userCode: 'ABCD-1234',
        verificationUri: 'https://github.com/login/device',
      }),
    ).toBe(true);
    expect(ok(Push, { type: 'login', state: 'code' })).toBe(false);
  });
});
