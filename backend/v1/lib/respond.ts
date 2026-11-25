import type { Response } from 'express';
import type { ApiResponse } from '../../types.js';

export function respond<T>(
  res: Response,
  statusCode: number,
  status: ApiResponse<T>['status'],
  data: T | null,
  message: string,
): Response<ApiResponse<T>> {
  return res.status(statusCode).json({ status, data, message });
}

export function ok<T>(res: Response, data: T | null, message = 'ok'): Response<ApiResponse<T>> {
  return respond(res, 200, 'success', data, message);
}

export function created<T>(
  res: Response,
  data: T | null,
  message = 'Created',
): Response<ApiResponse<T>> {
  return respond(res, 201, 'success', data, message);
}

export function fail<T = null>(
  res: Response,
  statusCode: number,
  message: string,
  data: T | null = null,
): Response<ApiResponse<T>> {
  return respond(res, statusCode, 'fail', data, message);
}

export function error<T = null>(
  res: Response,
  statusCode: number,
  message: string,
  data: T | null = null,
): Response<ApiResponse<T>> {
  return respond(res, statusCode, 'error', data, message);
}
