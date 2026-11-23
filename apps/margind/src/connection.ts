import { type ClientFrame, PROTOCOL, ServerFrame } from '@margin/protocol';
import * as v from 'valibot';

export type ConnectionState = 'connecting' | 'online' | 'offline';

export type ConnectionHandlers = {
  // Called before each attempt; false means don't connect (e.g. the app needs an update).
  beforeConnect(): Promise<boolean>;
  onState(state: ConnectionState): void;
  onFrame(frame: ServerFrame): void;
  // The server ended this session (signed out elsewhere or account deleted).
  // `elsewhere`: the account signed in on another Mac.
  onSessionEnded(elsewhere: boolean): void;
};

// One authenticated WebSocket to the server, reconnecting with backoff (1 s up to 30 s).
export class Connection {
  private ws?: WebSocket;
  private open = false;
  private stopped = false;
  private backoff = 1000;
  private retry?: Timer;
  private opening?: Timer;

  constructor(
    private server: string,
    private token: string,
    private handlers: ConnectionHandlers,
    // A handshake that never finishes is given up after this and tried again. After a wake
    // from sleep one was seen waiting forever for the server's answer, with every message
    // sent meanwhile left in the outbox.
    private options: { openTimeoutMs?: number } = {},
  ) {}

  get connected() {
    return this.open;
  }

  async start() {
    if (this.stopped) return;
    this.handlers.onState('connecting');
    if (!(await this.handlers.beforeConnect().catch(() => true)) || this.stopped) return;
    clearTimeout(this.retry);
    clearTimeout(this.opening);
    const ws = new WebSocket(`${this.server.replace(/^http/, 'ws')}/ws?protocol=${PROTOCOL}`, {
      headers: { authorization: `Bearer ${this.token}` },
    } as unknown as string[]);
    this.ws = ws;
    let ended = false;
    const reconnect = () => {
      if (ended) return;
      ended = true;
      clearTimeout(opening);
      if (this.ws !== ws || this.stopped) return;
      this.open = false;
      this.handlers.onState('offline');
      this.retry = setTimeout(() => void this.start(), this.backoff);
      this.backoff = Math.min(this.backoff * 2, 30_000);
    };
    const opening = setTimeout(() => {
      reconnect();
      ws.close();
    }, this.options.openTimeoutMs ?? 15_000);
    this.opening = opening;
    ws.onopen = () => {
      // Too late: this attempt was already given up.
      if (ended || this.ws !== ws || this.stopped) return ws.close();
      clearTimeout(opening);
      this.open = true;
      this.backoff = 1000;
      this.handlers.onState('online');
    };
    ws.onmessage = (event) => {
      let input: unknown;
      try {
        input = JSON.parse(String(event.data));
      } catch {
        return;
      }
      const parsed = v.safeParse(ServerFrame, input);
      if (parsed.success) this.handlers.onFrame(parsed.output);
    };
    ws.onclose = (event) => {
      this.open = false;
      if (this.ws !== ws || this.stopped) return;
      if (event.code === 4001 || event.code === 4002 || event.code === 4003) {
        clearTimeout(opening);
        this.stopped = true;
        this.handlers.onSessionEnded(event.code === 4003);
        return;
      }
      reconnect();
    };
    ws.onerror = () => {};
  }

  send(frame: ClientFrame) {
    if (!this.open || !this.ws) return false;
    this.ws.send(JSON.stringify(frame));
    return true;
  }

  stop() {
    this.stopped = true;
    clearTimeout(this.retry);
    clearTimeout(this.opening);
    this.ws?.close();
    this.open = false;
  }
}
