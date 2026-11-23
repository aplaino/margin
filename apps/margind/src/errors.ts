import { ApiError } from './api';
import { GitHubError } from './github';
import { ToolError } from './tools';

export class DaemonError extends Error {}

// Other errors can carry paths, so only Margin's own messages are logged (or reported) in full.
export const ownError = (e: unknown) =>
  e instanceof ApiError ||
  e instanceof DaemonError ||
  e instanceof GitHubError ||
  e instanceof ToolError;
export const log = (what: string, e?: unknown) => {
  const own = ownError(e);
  const detail = e
    ? ` (${(e as Error).name ?? 'error'}${own ? `: ${(e as Error).message}` : ''})`
    : '';
  console.error(`[margind] ${what}${detail}`);
};

export const errorText = (e: unknown) =>
  e instanceof ApiError ||
  e instanceof DaemonError ||
  e instanceof GitHubError ||
  e instanceof ToolError
    ? e.message
    : 'Something went wrong';
