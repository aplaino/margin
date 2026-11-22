// Lists crash and error reports sent to the server, newest first: `bun run crashes [days]`.
// Reads with the release token in this Mac's Keychain (service margin-release).

const server = process.env.MARGIN_SERVER ?? 'https://margin-api.fly.dev';
const days = Number(process.argv[2] ?? 7) || 7;
const token = Bun.spawnSync([
  'security',
  'find-generic-password',
  '-s',
  'margin-release',
  '-a',
  'release-token',
  '-w',
])
  .stdout.toString()
  .trim();
if (!token) {
  console.error(
    'No release token in the Keychain (service margin-release, account release-token).',
  );
  process.exit(1);
}

const since = Date.now() - days * 24 * 60 * 60_000;
const response = await fetch(`${server}/crash?since=${since}&limit=500`, {
  headers: { authorization: `Bearer ${token}` },
});
if (!response.ok) {
  console.error(`${server} answered ${response.status}`);
  process.exit(1);
}

type Row = {
  install: string;
  version: string;
  os: string;
  component: string;
  kind: string;
  what: string;
  detail: string;
  received_at: number;
};
const rows = (await response.json()) as Row[];
if (!rows.length) console.log(`No reports in the last ${days} days.`);
for (const r of rows) {
  const when = new Date(r.received_at).toLocaleString();
  console.log(
    `\n${when}  ${r.kind} in ${r.component}  ${r.version}  ${r.os}  install ${r.install.slice(0, 8)}`,
  );
  console.log(`  ${r.what}`);
  for (const line of r.detail.split('\n').slice(0, 30)) console.log(`    ${line}`);
}

export {};
