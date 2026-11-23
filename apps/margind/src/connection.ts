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

  constructor(
    private server: string,
    private token: string,
    private handlers: ConnectionHandlers,
  ) {}

  get connected() {
    return this.open;
  }

  async start() {
    if (this.stopped) return;
    this.handlers.onState('connecting');
    if (!(await this.handlers.beforeConnect().catch(() => true)) || this.stopped) return;
    const ws = new WebSocket(`${this.server.replace(/^http/, 'ws')}/ws?protocol=${PROTOCOL}`, {
      headers: { authorization: `Bearer ${this.token}` },
    } as unknown as string[]);
    this.ws = ws;
    ws.onopen = () => {
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
        this.stopped = true;
        this.handlers.onSessionEnded(event.code === 4003);
        return;
      }
      this.handlers.onState('offline');
      this.retry = setTimeout(() => void this.start(), this.backoff);
      this.backoff = Math.min(this.backoff * 2, 30_000);
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
    this.ws?.close();
    this.open = false;
  }
}
