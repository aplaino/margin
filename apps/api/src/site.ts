import { join } from 'node:path';

// The public website: one page plus its stylesheet and script, read once at start.
// No outside scripts, fonts or trackers, and a policy that keeps it that way.

const FILES: Record<string, { file: string; type: string }> = {
  '/': { file: 'index.html', type: 'text/html; charset=utf-8' },
  '/site.css': { file: 'site.css', type: 'text/css; charset=utf-8' },
  '/site.js': { file: 'site.js', type: 'text/javascript; charset=utf-8' },
};

const HEADERS = {
  'content-security-policy':
    "default-src 'none'; style-src 'self'; script-src 'self'; img-src 'self' data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
  'cache-control': 'public, max-age=300',
};

export async function site(dir: string) {
  const pages = new Map<string, { body: string; type: string }>();
  for (const [path, { file, type }] of Object.entries(FILES)) {
    const source = Bun.file(join(dir, file));
    if (await source.exists()) pages.set(path, { body: await source.text(), type });
  }
  return (req: Request, url: URL): Response | null => {
    if (req.method !== 'GET') return null;
    const page = pages.get(url.pathname);
    return page
      ? new Response(page.body, { headers: { ...HEADERS, 'content-type': page.type } })
      : null;
  };
}
