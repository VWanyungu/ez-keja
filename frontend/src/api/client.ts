const API_URL = import.meta.env.VITE_API_URL ?? 'http://localhost:3012';

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
    public details?: unknown,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

/** The backend wraps every answer as `{ status, data, message }`. */
interface Envelope<T> {
  status: string;
  data: T;
  message: string;
}

export async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const isFormData = init.body instanceof FormData;

  const res = await fetch(`${API_URL}${path}`, {
    ...init,
    credentials: 'include',
    headers: {
      'api-v': 'v1', // the API refuses requests without a version
      ...(init.body && !isFormData ? { 'Content-Type': 'application/json' } : {}),
      ...init.headers,
    },
  });

  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as Partial<Envelope<unknown>>;
    throw new ApiError(res.status, body.message ?? res.statusText, body.data);
  }

  if (res.status === 204) return undefined as T;
  return ((await res.json()) as Envelope<T>).data;
}
