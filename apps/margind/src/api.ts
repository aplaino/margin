import { CONTROL, PROTOCOL } from '@margin/protocol';
import * as v from 'valibot';

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

// HTTP calls to the Margin server. Every response that margind relies on is validated,
// because a server (or anything pretending to be one) is untrusted input too.
export class Api {
  constructor(
    readonly server: string,
    private token?: string,
  ) {}

  withToken(token: string) {
    return new Api(this.server, token);
  }

  async call<S extends v.GenericSchema | null>(
    schema: S,
    method: string,
    path: string,
    body?: unknown,
  ): Promise<S extends v.GenericSchema ? v.InferOutput<S> : unknown> {
    let response: Response;
    try {
      response = await fetch(this.server + path, {
        method,
        headers: {
          'x-margin-protocol': String(PROTOCOL),
          ...(this.token ? { authorization: `Bearer ${this.token}` } : {}),
          ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(10_000),
      });
    } catch {
      throw new ApiError(0, 'Can’t reach the Margin server');
    }
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      const error =
        typeof data?.error === 'string'
          ? data.error.replace(CONTROL, '').slice(0, 200)
          : `request failed (${response.status})`;
      throw new ApiError(response.status, error);
    }
    if (!schema) return data;
    const parsed = v.safeParse(schema, data);
    if (!parsed.success) throw new ApiError(502, 'unexpected response from the server');
    return parsed.output as never;
  }
}
