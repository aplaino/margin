import { connect, type Socket } from 'node:net';

const MAX_LINE = 1024 * 1024;

// Newline-delimited JSON over a Unix socket. A line longer than 1 MB closes the connection.
export function onLines(socket: Socket, handle: (value: unknown) => void) {
  let buffer = '';
  socket.setEncoding('utf8');
  socket.on('data', (chunk: string) => {
    buffer += chunk;
    let newline = buffer.indexOf('\n');
    while (newline >= 0) {
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      if (line.trim()) {
        try {
          handle(JSON.parse(line));
        } catch {}
      }
      newline = buffer.indexOf('\n');
    }
    if (buffer.length > MAX_LINE) socket.destroy();
  });
}

export function write(socket: Socket, value: unknown) {
  if (!socket.destroyed) socket.write(`${JSON.stringify(value)}\n`);
}

// Delivers one message and hangs up; false if nobody is listening.
export function sendOnce(path: string, value: unknown, timeoutMs = 500): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect(path);
    const done = (ok: boolean) => {
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(timeoutMs, () => done(false));
    socket.on('error', () => done(false));
    socket.on('connect', () => socket.end(`${JSON.stringify(value)}\n`, () => done(true)));
  });
}
