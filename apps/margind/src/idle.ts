// Seconds since the last keyboard or mouse input; 0 when it can't be read.
export async function idleSeconds(): Promise<number> {
  try {
    const process = Bun.spawn(['ioreg', '-c', 'IOHIDSystem', '-d', '4'], {
      stdout: 'pipe',
      stderr: 'ignore',
    });
    const out = await new Response(process.stdout).text();
    const ns = out.match(/"HIDIdleTime"\s*=\s*(\d+)/)?.[1];
    return ns ? Number(BigInt(ns) / 1_000_000_000n) : 0;
  } catch {
    return 0;
  }
}
