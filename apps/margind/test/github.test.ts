import { afterEach, describe, expect, test } from 'bun:test';
import { GitHubError, githubDeviceLogin } from '../src/github';

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

const answer = (fn: () => Response | Promise<Response>) => {
  globalThis.fetch = (async () => fn()) as unknown as typeof fetch;
};

describe('GitHub sign-in failures say what happened', () => {
  test('no connection', async () => {
    answer(() => {
      throw new TypeError('fetch failed');
    });
    const error = await githubDeviceLogin('id', () => {}).catch((e) => e);
    expect(error).toBeInstanceOf(GitHubError);
    expect(error.message).toContain('Can’t reach GitHub');
  });

  test('rate limited', async () => {
    answer(() => new Response('', { status: 429 }));
    expect((await githubDeviceLogin('id', () => {}).catch((e) => e)).message).toContain(
      'GitHub is busy',
    );
  });

  test('device flow switched off for the app', async () => {
    answer(() => Response.json({ error: 'device_flow_disabled' }));
    const error = await githubDeviceLogin('id', () => {}).catch((e) => e);
    expect(error).toBeInstanceOf(GitHubError);
  });

  test('a verification page that isn’t GitHub’s is refused', async () => {
    answer(() =>
      Response.json({
        device_code: 'd',
        user_code: 'u',
        verification_uri: 'https://evil.example/',
      }),
    );
    expect(await githubDeviceLogin('id', () => {}).catch((e) => e)).toBeInstanceOf(GitHubError);
  });
});
