import { afterEach, expect, test } from 'bun:test';
import { Connection, type ConnectionState } from '../src/connection';

const cleanup: (() => void)[] = [];
afterEach(() => {
  for (const fn of cleanup.splice(0).reverse()) fn();
});

// Seen after a wake from sleep: the upgrade request goes out and the server never answers it.
test('a handshake that never finishes is given up and tried again', async () => {
  let attempts = 0;
  const silent = Bun.listen({
    hostname: '127.0.0.1',
    port: 0,
    socket: {
      open() {
        attempts++;
      },
      data() {},
    },
  });
  cleanup.push(() => silent.stop(true));

  const states: ConnectionState[] = [];
  const connection = new Connection(
    `http://127.0.0.1:${silent.port}`,
    'token',
    {
      beforeConnect: async () => true,
      onState: (state) => states.push(state),
      onFrame: () => {},
      onSessionEnded: () => {},
    },
    { openTimeoutMs: 200 },
  );
  cleanup.push(() => connection.stop());
  await connection.start();

  const deadline = Date.now() + 3000;
  while (attempts < 2 && Date.now() < deadline) await Bun.sleep(50);
  expect(attempts).toBeGreaterThanOrEqual(2);
  expect(states.slice(0, 3)).toEqual(['connecting', 'offline', 'connecting']);
});

test('a stopped connection doesn’t try again when its handshake times out', async () => {
  let attempts = 0;
  const silent = Bun.listen({
    hostname: '127.0.0.1',
    port: 0,
    socket: {
      open() {
        attempts++;
      },
      data() {},
    },
  });
  cleanup.push(() => silent.stop(true));

  const states: ConnectionState[] = [];
  const connection = new Connection(
    `http://127.0.0.1:${silent.port}`,
    'token',
    {
      beforeConnect: async () => true,
      onState: (state) => states.push(state),
      onFrame: () => {},
      onSessionEnded: () => {},
    },
    { openTimeoutMs: 100 },
  );
  await connection.start();
  while (attempts < 1) await Bun.sleep(10);
  connection.stop();
  await Bun.sleep(1500);
  expect(attempts).toBe(1);
  expect(states).toEqual(['connecting']);
});
