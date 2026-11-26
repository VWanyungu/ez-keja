import express, { type ErrorRequestHandler, type Express } from 'express';
import { toNodeHandler } from 'better-auth/node';
import cors from 'cors';
import helmet from 'helmet';
import morgan from 'morgan';
import checkVersion from './middlewares/version.js';
import { auth } from './v1/lib/auth.js';
import { HttpError } from './v1/lib/http-error.js';
import { parseTrustProxy, resolveCorsOrigin } from './v1/lib/http-config.js';
import healthRoutes from './v1/modules/health/routes.js';

export function createApp(): Express {
  const app = express();

  // Off unless TRUST_PROXY is set (e.g. 1 behind nginx/DirectAdmin), so req.ip is the real client.
  app.set('trust proxy', parseTrustProxy(process.env.TRUST_PROXY));

  app.use(helmet());
  app.use(cors({ origin: resolveCorsOrigin(), credentials: true }));
  app.use(morgan(process.env.NODE_ENV === 'production' ? 'combined' : 'dev'));

  // Better Auth reads the raw request stream directly, so mount it before express.json().
  app.all('/api/auth/*splat', toNodeHandler(auth));

  app.use(express.json());
  app.use('/health', healthRoutes);
  app.use(checkVersion());

  const errorHandler: ErrorRequestHandler = (err, _req, res, _next) => {
    console.error(err);
    const status = typeof err?.status === 'number' ? err.status : 500;
    const expose = Boolean(err?.expose);
    const message = expose ? err.message : 'Internal server error';
    const data = expose && err instanceof HttpError && err.data !== undefined ? err.data : null;
    const code = expose && typeof err?.code === 'string' ? err.code : undefined;

    res.status(status).json({
      status: 'error',
      data,
      message,
      ...(code !== undefined ? { code } : {}),
    });
  };
  app.use(errorHandler);

  return app;
}
