export interface HttpErrorOptions {
  expose?: boolean;
  code?: string;
  data?: unknown;
  cause?: unknown;
}

/** HTTP-aware error handled by the Express error middleware in backend/index.ts. */
export class HttpError extends Error {
  readonly status: number;
  readonly expose: boolean;
  readonly code?: string;
  readonly data?: unknown;

  constructor(status: number, message: string, options: HttpErrorOptions = {}) {
    super(message, options.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = 'HttpError';
    this.status = status;
    this.expose = options.expose ?? status < 500;
    if (options.code !== undefined) this.code = options.code;
    if (options.data !== undefined) this.data = options.data;
  }
}

export const badRequest = (message = 'Bad request', options?: HttpErrorOptions) =>
  new HttpError(400, message, options);

export const unauthorized = (message = 'Unauthorized', options?: HttpErrorOptions) =>
  new HttpError(401, message, options);

export const forbidden = (message = 'Forbidden', options?: HttpErrorOptions) =>
  new HttpError(403, message, options);

export const notFound = (message = 'Not found', options?: HttpErrorOptions) =>
  new HttpError(404, message, options);

export const conflict = (message = 'Conflict', options?: HttpErrorOptions) =>
  new HttpError(409, message, options);

export const serviceUnavailable = (message = 'Service unavailable', options?: HttpErrorOptions) =>
  new HttpError(503, message, { expose: true, ...options });
