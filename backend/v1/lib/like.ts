/** Escapes `\`, `%` and `_` so user text is matched literally in an `ILIKE ... ESCAPE '\'` pattern. */
export const escapeLike = (text: string): string => text.replace(/[\\%_]/g, '\\$&');
