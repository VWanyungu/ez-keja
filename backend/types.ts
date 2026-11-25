export interface ApiResponse<T = unknown> {
  status: 'success' | 'fail' | 'error';
  data: T | null;
  message: string;
}
