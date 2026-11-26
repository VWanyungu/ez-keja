import { describe, expect, it } from 'bun:test';
import http from 'node:http';
import { createShutdown } from './shutdown.js';

async function listen(handler: http.RequestListener): Promise<{ server: http.Server; base: string }> {
  const server = http.createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address();
  if (!addr || typeof addr === 'string') throw new Error('no port');
  return { server, base: `http://127.0.0.1:${addr.port}` };
}

function harness(server: http.Server, timeoutMs: number, closers: Array<() => Promise<void>>) {
  const order: string[] = [];
  let exitCode: number | undefined;
  const wrapped = closers.map((close, i) => async () => {
    order.push(`closer${i}`);
    await close();
  });
  const shutdown = createShutdown({
    server,
    closers: wrapped,
    timeoutMs,
    log: () => {},
    exit: (code) => {
      order.push('exit');
      exitCode = code;
    },
  });
  return { shutdown, order, code: () => exitCode };
}

describe('createShutdown', () => {
  it('lets an in-flight request finish, refuses new ones, closes the pools, then exits 0', async () => {
    const { server, base } = await listen((_req, res) => {
      setTimeout(() => res.end('finished'), 300);
    });
    const inFlight = fetch(base).then((r) => r.text());
    await Bun.sleep(50);

    const h = harness(server, 5_000, [async () => {}, async () => {}]);
    const done = h.shutdown('SIGTERM');
    await Bun.sleep(50);

    await expect(fetch(base)).rejects.toThrow(); // the listener is closed
    expect(await inFlight).toBe('finished');
    await done;

    expect(h.order).toEqual(['closer0', 'closer1', 'exit']);
    expect(h.code()).toBe(0);
  });

  it('gives up on requests that outlive the timeout, still closes the pools and exits 1', async () => {
    // A stub server whose close callback never fires, like a request that never finishes. (Bun's own
    // closeAllConnections does not cut live sockets; process exit does, so the pools must still close.)
    let cutAll = 0;
    const stuckServer = {
      close: () => {},
      closeAllConnections: () => void (cutAll += 1),
    } as unknown as http.Server;

    const h = harness(stuckServer, 150, [async () => {}]);
    await h.shutdown('SIGINT');

    expect(cutAll).toBe(1);
    expect(h.order).toEqual(['closer0', 'exit']);
    expect(h.code()).toBe(1);
  });

  it('keeps closing the remaining pools when one fails, exits 1, and ignores a second signal', async () => {
    const { server } = await listen((_req, res) => void res.end());
    const h = harness(server, 1_000, [
      async () => {
        throw new Error('pool already closed');
      },
      async () => {},
    ]);
    await Promise.all([h.shutdown('SIGTERM'), h.shutdown('SIGINT')]);

    expect(h.order).toEqual(['closer0', 'closer1', 'exit']);
    expect(h.code()).toBe(1);
  });
});
