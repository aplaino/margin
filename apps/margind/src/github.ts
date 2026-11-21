// GitHub's device flow: Margin shows a code, you enter it at github.com/login/device, and
// GitHub hands margind a token that's used once to prove who you are. No scopes are
// requested, so it can only read your public profile.

// Failures with a message fit to show you in the drawer.
export class GitHubError extends Error {}

export type DeviceCode = { userCode: string; verificationUri: string };
export type DeviceLogin = (clientId: string, onCode: (code: DeviceCode) => void) => Promise<string>;

const post = async (url: string, body: Record<string, string>) => {
  let response: Response;
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: { Accept: 'application/json', 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(10_000),
    });
  } catch {
    throw new GitHubError('Can’t reach GitHub. Check your connection and try again.');
  }
  if (response.status === 429)
    throw new GitHubError('GitHub is busy. Wait a minute and try again.');
  const data = await response.json().catch(() => null);
  if (!data || typeof data !== 'object')
    throw new GitHubError('GitHub sent an unexpected answer. Try again.');
  return data as Record<string, unknown>;
};

export const githubDeviceLogin: DeviceLogin = async (clientId, onCode) => {
  const start = await post('https://github.com/login/device/code', {
    client_id: clientId,
    scope: '',
  });
  const uri = String(start.verification_uri ?? '');
  if (
    typeof start.device_code !== 'string' ||
    typeof start.user_code !== 'string' ||
    !uri.startsWith('https://github.com/')
  ) {
    throw new GitHubError('GitHub didn’t start sign-in');
  }
  onCode({ userCode: start.user_code.slice(0, 16), verificationUri: uri });
  let interval = Number(start.interval) || 5;
  const deadline = Date.now() + (Number(start.expires_in) || 900) * 1000;
  while (Date.now() < deadline) {
    await Bun.sleep(interval * 1000);
    const poll = await post('https://github.com/login/oauth/access_token', {
      client_id: clientId,
      device_code: start.device_code,
      grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
    });
    if (typeof poll.access_token === 'string') return poll.access_token;
    if (poll.error === 'slow_down') interval += 5;
    else if (poll.error !== 'authorization_pending')
      throw new GitHubError('GitHub sign-in was cancelled or expired');
  }
  throw new GitHubError('GitHub sign-in expired');
};
