import { existsSync, mkdirSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import type { SQL } from 'bun';
import { tokenMatches } from './limits';

// Margin.app updates: release zips on disk, an appcast for Sparkle, and /download for the
// first install. Releases are uploaded with a token; Sparkle verifies each zip with the
// EdDSA signature recorded here, so the server can't swap a build without the release key.

export type UpdateOptions = {
  // Where release zips live (a Fly volume in production).
  dir: string;
  // Bearer token for uploading releases; uploads are off without one.
  releaseToken?: string;
  // The address the server is reached at, for links in the appcast (https in production).
  publicUrl?: string;
};

const VERSION = /^\d{1,4}\.\d{1,4}\.\d{1,4}$/;
const SIGNATURE = /^[A-Za-z0-9+/]{40,120}={0,2}$/;
const SYSTEM = /^\d{1,3}\.\d{1,3}$/;
const MAX_ZIP = 300 * 1024 * 1024;

type Release = {
  version: string;
  build: number;
  signature: string;
  length: number;
  min_system: string;
  created_at: number;
};

const json = (body: unknown, status = 200) => Response.json(body, { status });
const esc = (s: string) => s.replace(/[<>&"']/g, (c) => `&#${c.charCodeAt(0)};`);
const zipName = (build: number) => `Margin-${build}.zip`;
const imageName = (build: number) => `Margin-${build}.dmg`;

export function updates(sql: SQL, options: UpdateOptions) {
  mkdirSync(options.dir, { recursive: true });
  const base = (url: URL) => (options.publicUrl ?? url.origin).replace(/\/$/, '');

  async function latest(limit: number): Promise<Release[]> {
    const rows = await sql`SELECT * FROM releases ORDER BY build DESC LIMIT ${limit}`;
    return rows.map((r: Release) => ({
      ...r,
      build: Number(r.build),
      length: Number(r.length),
      created_at: Number(r.created_at),
    }));
  }

  async function upload(req: Request) {
    if (!options.releaseToken) return json({ error: 'not found' }, 404);
    if (!tokenMatches(req.headers.get('authorization'), options.releaseToken))
      return json({ error: 'unauthorized' }, 401);
    const version = req.headers.get('x-release-version') ?? '';
    const build = Number(req.headers.get('x-release-build'));
    const signature = req.headers.get('x-release-signature') ?? '';
    const minSystem = req.headers.get('x-release-min-system') ?? '26.0';
    if (
      !VERSION.test(version) ||
      !Number.isSafeInteger(build) ||
      build < 1 ||
      !SIGNATURE.test(signature) ||
      !SYSTEM.test(minSystem)
    ) {
      return json({ error: 'invalid release' }, 400);
    }
    const [{ newest }] = await sql`SELECT MAX(build) AS newest FROM releases`;
    if (newest !== null && build <= Number(newest))
      return json({ error: `build must be newer than ${newest}` }, 409);
    const bytes = await req.arrayBuffer();
    if (bytes.byteLength === 0 || bytes.byteLength > MAX_ZIP)
      return json({ error: 'invalid release' }, 400);
    // Written aside and renamed into place, so a half-uploaded zip is never served.
    const path = join(options.dir, zipName(build));
    await Bun.write(`${path}.partial`, bytes);
    renameSync(`${path}.partial`, path);
    await sql`INSERT INTO releases ${sql({
      version,
      build,
      signature,
      length: bytes.byteLength,
      min_system: minSystem,
      created_at: Date.now(),
    })}`;
    return json({ version, build, length: bytes.byteLength });
  }

  // The disk image for an existing release, for first installs from the website.
  async function uploadImage(req: Request, build: number) {
    if (!options.releaseToken) return json({ error: 'not found' }, 404);
    if (!tokenMatches(req.headers.get('authorization'), options.releaseToken))
      return json({ error: 'unauthorized' }, 401);
    const [release] = await sql`SELECT build FROM releases WHERE build = ${build}`;
    if (!release) return json({ error: 'no such release' }, 404);
    const bytes = await req.arrayBuffer();
    if (bytes.byteLength === 0 || bytes.byteLength > MAX_ZIP)
      return json({ error: 'invalid image' }, 400);
    const path = join(options.dir, imageName(build));
    await Bun.write(`${path}.partial`, bytes);
    renameSync(`${path}.partial`, path);
    return json({ build, length: bytes.byteLength });
  }

  async function appcast(url: URL) {
    const items = (await latest(5))
      .map(
        (r) => `    <item>
      <title>Margin ${esc(r.version)}</title>
      <pubDate>${new Date(r.created_at).toUTCString()}</pubDate>
      <sparkle:version>${r.build}</sparkle:version>
      <sparkle:shortVersionString>${esc(r.version)}</sparkle:shortVersionString>
      <sparkle:minimumSystemVersion>${esc(r.min_system)}</sparkle:minimumSystemVersion>
      <enclosure url="${esc(`${base(url)}/updates/${zipName(r.build)}`)}" length="${r.length}" type="application/octet-stream" sparkle:edSignature="${esc(r.signature)}"/>
    </item>`,
      )
      .join('\n');
    const xml = `<?xml version="1.0" encoding="utf-8"?>
<rss version="2.0" xmlns:sparkle="http://www.andymatuschak.org/xml-namespaces/sparkle">
  <channel>
    <title>Margin</title>
${items}
  </channel>
</rss>
`;
    return new Response(xml, {
      headers: { 'content-type': 'application/xml; charset=utf-8', 'cache-control': 'no-cache' },
    });
  }

  function zip(build: number, filename = zipName(build)) {
    return serveFile(zipName(build), filename, 'application/zip');
  }

  function serveFile(name: string, filename: string, type: string) {
    const path = join(options.dir, name);
    if (!existsSync(path)) return json({ error: 'not found' }, 404);
    return new Response(Bun.file(path), {
      headers: {
        'content-type': type,
        'content-disposition': `attachment; filename="${filename}"`,
      },
    });
  }

  // Returns a response for update routes, or null for anything else.
  return async (req: Request, url: URL): Promise<Response | null> => {
    const path = url.pathname;
    if (req.method === 'POST' && path === '/updates/releases') return upload(req);
    const image = path.match(/^\/updates\/releases\/(\d{1,9})\/dmg$/);
    if (req.method === 'POST' && image) return uploadImage(req, Number(image[1]));
    if (req.method !== 'GET' && req.method !== 'HEAD') return null;
    if (path === '/updates/appcast.xml') return appcast(url);
    // The Terminal installer, and the zip it fetches (Terminal downloads skip Chrome's and
    // macOS's warnings, which only apply to files downloaded in a browser).
    if (path === '/install.sh') {
      return new Response(installer(base(url)), {
        headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-cache' },
      });
    }
    if (path === '/download.zip') {
      const [newest] = await latest(1);
      return newest ? zip(newest.build, 'Margin.zip') : json({ error: 'no release yet' }, 404);
    }
    // First installs get the newest disk image, or the zip for releases made before images.
    if (path === '/download') {
      const [newest] = await latest(1);
      if (!newest) return json({ error: 'no release yet' }, 404);
      return existsSync(join(options.dir, imageName(newest.build)))
        ? serveFile(imageName(newest.build), 'Margin.dmg', 'application/x-apple-diskimage')
        : zip(newest.build, 'Margin.zip');
    }
    const file = path.match(/^\/updates\/Margin-(\d{1,9})\.zip$/);
    return file ? zip(Number(file[1])) : null;
  };
}

// curl -fsSL <server>/install.sh | sh
function installer(base: string) {
  return `#!/bin/sh
# Installs Margin into /Applications and opens it.
set -eu
[ "$(uname -s)" = Darwin ] || { echo "Margin is a Mac app." >&2; exit 1; }
[ "$(uname -m)" = arm64 ] || { echo "Margin needs a Mac with Apple silicon." >&2; exit 1; }
[ "$(sw_vers -productVersion | cut -d. -f1)" -ge 26 ] || { echo "Margin needs macOS 26 or later." >&2; exit 1; }

tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
echo "Downloading Margin…"
curl -fsSL "${base}/download.zip" -o "$tmp/Margin.zip"
ditto -x -k "$tmp/Margin.zip" "$tmp"
if ! codesign --verify --deep --strict "$tmp/Margin.app" 2>/dev/null ||
   [ "$(defaults read "$tmp/Margin.app/Contents/Info" CFBundleIdentifier 2>/dev/null)" != dev.margin.app ]; then
  echo "The download didn't check out, so nothing was installed." >&2
  exit 1
fi

osascript -e 'quit app id "dev.margin.app"' >/dev/null 2>&1 || true
sleep 1
if [ -e /Applications/Margin.app ]; then
  mv /Applications/Margin.app "$HOME/.Trash/Margin $(date '+%Y-%m-%d %H.%M.%S').app"
fi
ditto "$tmp/Margin.app" /Applications/Margin.app
open /Applications/Margin.app
echo "Margin is installed. Look for the strip at the edge of your screen."
`;
}
