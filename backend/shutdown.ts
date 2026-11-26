import type { Server } from 'node:http';

export interface ShutdownOptions {
  server: Pick<Server, 'close'> & Partial<Pick<Server, 'closeIdleConnections' | 'closeAllConnections'>>;
  /** Run after the server has drained, e.g. closeDb and closeAuthPool. A failing closer does not stop the others. */
  closers: Array<() => Promise<void>>;
  /** How long in-flight requests get before their sockets are cut. Keep it below PM2 `kill_timeout`. */
  timeoutMs?: number;
  exit?: (code: number) => void;
  log?: (message: string) => void;
}

export const DEFAULT_SHUTDOWN_TIMEOUT_MS = 10_000;

/**
 * Graceful shutdown: stop accepting connections, let in-flight requests finish (up to `timeoutMs`),
 * close the database pools, then exit. Idle keep-alive sockets are closed as they appear, because
 * `server.close()` alone waits for them. Calling the returned function twice does nothing the second time.
 */
export function createShutdown(options: ShutdownOptions): (signal: string) => Promise<void> {
  const { server, closers } = options;
  const timeoutMs = options.timeoutMs ?? DEFAULT_SHUTDOWN_TIMEOUT_MS;
  const exit = options.exit ?? ((code: number) => process.exit(code));
  const log = options.log ?? ((message: string) => console.log(message));
  let running: Promise<void> | undefined;

  async function run(signal: string): Promise<void> {
    log(`${signal} received: no longer accepting connections, draining in-flight requests`);
    let failed = false;

    let timer: ReturnType<typeof setTimeout> | undefined;
    let sweeper: ReturnType<typeof setInterval> | undefined;
    const drained = new Promise<'drained'>((resolve) => {
      server.close(() => resolve('drained'));
      sweeper = setInterval(() => server.closeIdleConnections?.(), 250);
      server.closeIdleConnections?.();
    });
    const timedOut = new Promise<'timeout'>((resolve) => {
      timer = setTimeout(() => resolve('timeout'), timeoutMs);
    });

    if ((await Promise.race([drained, timedOut])) === 'timeout') {
      failed = true;
      log(`Requests still running after ${timeoutMs} ms: closing their connections`);
      server.closeAllConnections?.();
    }
    clearTimeout(timer);
    clearInterval(sweeper);

    for (const close of closers) {
      try {
        await close();
      } catch (err) {
        failed = true;
        log(`Shutdown step failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    log('Shutdown complete');
    exit(failed ? 1 : 0);
  }

  return (signal) => {
    running ??= run(signal);
    return running;
  };
}
