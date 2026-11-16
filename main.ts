// Entry point: start the forge on an ephemeral port, register that port with the env, then poll the
// env until it reports the trial done, and exit 0.
//
//   MAKEFUN_ENV_URL   the env's origin; required (exit 1 without it).
//   MAKEFUN_SHOP_TOKEN  the bearer token API calls must carry.
//   MAKEFUN_TRIAL_NOW   the trial clock; every timestamp the forge writes derives from it.
//
// Run standalone without MAKEFUN_ENV_URL by setting FORGE_PORT: the forge then just serves.

import { createForgeServer, defaultOptions } from './src/server.ts';

const REQUEST_TIMEOUT_MS = 30_000;
const BACKOFF_FIRST_MS = 200;
const BACKOFF_MAX_MS = 2_000;

const envUrl = (process.env.MAKEFUN_ENV_URL ?? '').replace(/\/+$/, '');
const standalonePort = process.env.FORGE_PORT;

function log(line: string): void {
  process.stdout.write(`[forge] ${line}\n`);
}

function pause(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function backoff(attempt: number): number {
  return Math.min(BACKOFF_MAX_MS, BACKOFF_FIRST_MS * 2 ** Math.min(attempt, 10));
}

/** POST {"port"} until the env takes it: 200 registers, 409 means a registration already won. */
async function register(port: number): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    try {
      const res = await fetch(`${envUrl}/register`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ port }),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      if (res.status === 200 || res.status === 409) return;
      const detail = await res.text().catch(() => '');
      if (res.status === 400 || res.status === 405) throw new Error(`register refused with HTTP ${res.status}: ${detail}`);
    } catch (err) {
      if (err instanceof Error && err.message.startsWith('register refused')) throw err;
    }
    await pause(backoff(attempt));
  }
}

/** Poll GET /done until {"done": true}; transient failures are retried, never fatal. */
async function untilDone(): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    try {
      const res = await fetch(`${envUrl}/done`, { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
      if (res.ok && ((await res.json()) as { done?: unknown }).done === true) return;
      if (res.ok) attempt = 0;
    } catch {
      // not answering yet: poll again
    }
    await pause(backoff(attempt));
  }
}

async function main(): Promise<number> {
  if (envUrl === '' && !standalonePort) {
    process.stderr.write('[forge] MAKEFUN_ENV_URL is not set (set FORGE_PORT to run standalone)\n');
    return 1;
  }
  const server = createForgeServer(defaultOptions());
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(envUrl === '' ? Number(standalonePort) : 0, () => resolve());
  });
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('the server did not bind a TCP port');
  log(`listening on port ${address.port}`);
  if (envUrl === '') return new Promise<number>(() => undefined); // standalone: serve until killed

  await register(address.port);
  log('registered with the env; serving until it reports done');
  await untilDone();
  server.close();
  server.closeAllConnections();
  log('done');
  return 0;
}

main().then(
  (code) => process.exit(code),
  (err: unknown) => {
    process.stderr.write(`[forge] ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  },
);
