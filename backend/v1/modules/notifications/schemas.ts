import { badRequest } from '../../lib/http-error.js';
import { parseKeysetQuery, type KeysetQuery } from '../../lib/keyset.js';

export interface ListNotificationsQuery extends KeysetQuery {
  unreadOnly: boolean;
}

export function parseListNotificationsQuery(query: Record<string, unknown>): ListNotificationsQuery {
  let unreadOnly = false;
  if (query.unread !== undefined) {
    if (query.unread !== 'true' && query.unread !== 'false') throw badRequest('Query "unread" must be "true" or "false".');
    unreadOnly = query.unread === 'true';
  }
  return { ...parseKeysetQuery(query), unreadOnly };
}
