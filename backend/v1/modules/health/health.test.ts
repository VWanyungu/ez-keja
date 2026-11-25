import { afterEach, describe, expect, it } from 'bun:test';
import express, { type ErrorRequestHandler } from 'express';
import type { Server } from 'node:http';
import { HttpError, badRequest, serviceUnavailable } from '../../lib/http-error.js';
import { parseHealthQuery } from './schemas.js';
import { getHealthStatus } from './service.js';
import { createHealthRouter } from './routes.js';

const testErrorHandler: ErrorRequestHandler = (err, _req, res, _next) => {
  const status = typeof err?.status === 'number' ? err.status : 500;
  const message = err?.expose ? err.message : 'Internal server error';
  res.status(status).json({ status: 'error', data: null, message });
};

let activeServer: Server | null = null;

afterEach(async () => {
  if (activeServer) {
    await new Promise<void>((resolve, reject) => {
      activeServer!.close((err) => (err ? reject(err) : resolve()));
    });
    activeServer = null;
  }
});

async function startHealthApp(
  resolver: Parameters<typeof createHealthRouter>[0],
): Promise<string> {
  const app = express();
  app.use('/health', createHealthRouter(resolver));
  app.use(testErrorHandler);

  await new Promise<void>((resolve) => {
    activeServer = app.listen(0, '127.0.0.1', () => resolve());
  });

  const addr = activeServer!.address();
  if (!addr || typeof addr === 'string') {
    throw new Error('Failed to bind ephemeral test port');
  }
  return `http://127.0.0.1:${addr.port}`;
}

describe('parseHealthQuery', () => {
  it('defaults to "all" when check is omitted or empty', () => {
    expect(parseHealthQuery({})).toEqual({ check: 'all' });
    expect(parseHealthQuery({ check: '' })).toEqual({ check: 'all' });
  });

  it('accepts "all" and "live"', () => {
    expect(parseHealthQuery({ check: 'all' })).toEqual({ check: 'all' });
    expect(parseHealthQuery({ check: 'live' })).toEqual({ check: 'live' });
  });

  it('throws 400 HttpError for invalid check values', () => {
    expect(() => parseHealthQuery({ check: 'db' })).toThrow(HttpError);
    try {
      parseHealthQuery({ check: 'db' });
    } catch (err) {
      expect(err).toBeInstanceOf(HttpError);
      expect((err as HttpError).status).toBe(400);
      expect((err as HttpError).expose).toBe(true);
    }
  });
});

describe('getHealthStatus', () => {
  it('returns ok and database latency when DB ping succeeds', async () => {
    const result = await getHealthStatus(
      { check: 'all' },
      { pingDb: async () => ({ rows: [{ '?column?': 1 }] }) },
    );

    expect(result.healthy).toBe(true);
    expect(result.data.status).toBe('ok');
    expect(typeof result.data.uptime).toBe('number');
    expect(Number.isNaN(Date.parse(result.data.timestamp))).toBe(false);
    expect(result.data.checks.database?.status).toBe('up');
    expect(typeof result.data.checks.database?.latencyMs).toBe('number');
  });

  it('returns degraded when DB ping rejects', async () => {
    const origError = console.error;
    console.error = () => {};
    try {
      const result = await getHealthStatus(
        { check: 'all' },
        { pingDb: async () => Promise.reject(new Error('ECONNREFUSED')) },
      );

      expect(result.healthy).toBe(false);
      expect(result.data.status).toBe('degraded');
      expect(result.data.checks.database).toEqual({ status: 'down', latencyMs: null });
    } finally {
      console.error = origError;
    }
  });

  it('returns degraded when DB ping exceeds timeout', async () => {
    const origError = console.error;
    console.error = () => {};
    try {
      const result = await getHealthStatus(
        { check: 'all' },
        {
          pingDb: () => new Promise(() => {}),
          timeoutMs: 20,
        },
      );

      expect(result.healthy).toBe(false);
      expect(result.data.status).toBe('degraded');
      expect(result.data.checks.database).toEqual({ status: 'down', latencyMs: null });
    } finally {
      console.error = origError;
    }
  });

  it('skips database check when check=live', async () => {
    let called = false;
    const result = await getHealthStatus(
      { check: 'live' },
      {
        pingDb: async () => {
          called = true;
          return true;
        },
      },
    );

    expect(called).toBe(false);
    expect(result.healthy).toBe(true);
    expect(result.data.status).toBe('ok');
    expect(result.data.checks).toEqual({});
  });
});

describe('GET /health route', () => {
  it('returns 200 ApiResponse when healthy', async () => {
    const baseUrl = await startHealthApp((query) =>
      getHealthStatus(query, { pingDb: async () => true }),
    );

    const res = await fetch(`${baseUrl}/health`);
    const body = (await res.json()) as Record<string, unknown>;

    expect(res.status).toBe(200);
    expect(body.status).toBe('success');
    expect(body.message).toBe('Service is healthy');
    expect((body.data as { status: string }).status).toBe('ok');
  });

  it('returns 503 ApiResponse when database is down', async () => {
    const origError = console.error;
    console.error = () => {};
    try {
      const baseUrl = await startHealthApp((query) =>
        getHealthStatus(query, { pingDb: async () => Promise.reject(new Error('down')) }),
      );

      const res = await fetch(`${baseUrl}/health`);
      const body = (await res.json()) as Record<string, unknown>;

      expect(res.status).toBe(503);
      expect(body.status).toBe('error');
      expect(body.message).toBe('Service unavailable');
      expect((body.data as { status: string }).status).toBe('degraded');
    } finally {
      console.error = origError;
    }
  });

  it('returns 400 ApiResponse for invalid query param', async () => {
    const baseUrl = await startHealthApp((query) =>
      getHealthStatus(query, { pingDb: async () => true }),
    );

    const res = await fetch(`${baseUrl}/health?check=bogus`);
    const body = (await res.json()) as Record<string, unknown>;

    expect(res.status).toBe(400);
    expect(body.status).toBe('error');
    expect(body.data).toBeNull();
    expect(body.message).toContain('Invalid check parameter');
  });
});

describe('HttpError helpers', () => {
  it('sets status and expose defaults properly', () => {
    const err400 = badRequest('Bad input');
    expect(err400.status).toBe(400);
    expect(err400.expose).toBe(true);

    const err503 = serviceUnavailable();
    expect(err503.status).toBe(503);
    expect(err503.expose).toBe(true);

    const err500 = new HttpError(500, 'Secret detail');
    expect(err500.status).toBe(500);
    expect(err500.expose).toBe(false);
  });
});
