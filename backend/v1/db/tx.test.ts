import { describe, expect, it } from 'bun:test';
import { withTx, type TxRunner } from './tx.js';

/** A runner whose first attempts fail with the queued errors, then run `fn`. */
function fakeRunner(failures: unknown[]) {
  let attempts = 0;
  const runner = {
    transaction: async (fn: (trx: never) => Promise<unknown>) => {
      attempts += 1;
      const failure = failures.shift();
      if (failure !== undefined) throw failure;
      return fn({} as never);
    },
  } as unknown as TxRunner;
  return { runner, attempts: () => attempts };
}

const pgError = (code: string) => Object.assign(new Error(`pg ${code}`), { code });

describe('withTx', () => {
  it('returns the result without a retry when the transaction succeeds', async () => {
    const { runner, attempts } = fakeRunner([]);
    expect(await withTx(async () => 'done', runner)).toBe('done');
    expect(attempts()).toBe(1);
  });

  it.each(['40P01', '40001'])('retries once on SQLSTATE %s', async (code) => {
    const { runner, attempts } = fakeRunner([pgError(code)]);
    expect(await withTx(async () => 'done', runner)).toBe('done');
    expect(attempts()).toBe(2);
  });

  it('gives up after one retry', async () => {
    const { runner, attempts } = fakeRunner([pgError('40P01'), pgError('40P01'), pgError('40P01')]);
    await expect(withTx(async () => 'done', runner)).rejects.toThrow('pg 40P01');
    expect(attempts()).toBe(2);
  });

  it('does not retry other errors', async () => {
    const { runner, attempts } = fakeRunner([pgError('23505')]);
    await expect(withTx(async () => 'done', runner)).rejects.toThrow('pg 23505');
    expect(attempts()).toBe(1);

    const plain = fakeRunner([new Error('boom')]);
    await expect(withTx(async () => 'done', plain.runner)).rejects.toThrow('boom');
    expect(plain.attempts()).toBe(1);
  });
});
