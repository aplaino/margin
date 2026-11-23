import * as v from 'valibot';

export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export const notFound = () => new HttpError(404, 'not found');
export const json = (body: unknown, status = 200) => Response.json(body, { status });

// The decoded first capture of `pattern` in `path`, or null when it doesn't match.
export function param(path: string, pattern: RegExp) {
  const match = path.match(pattern);
  return match ? decodeURIComponent(match[1] ?? '') : null;
}

export async function parseBody<T extends v.GenericSchema>(schema: T, req: Request) {
  let input: unknown;
  try {
    input = await req.json();
  } catch {
    throw new HttpError(400, 'invalid JSON');
  }
  const result = v.safeParse(schema, input);
  if (!result.success) throw new HttpError(400, 'invalid request');
  return result.output as v.InferOutput<T>;
}
