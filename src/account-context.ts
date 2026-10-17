import { AsyncLocalStorage } from 'node:async_hooks';

const accountContext = new AsyncLocalStorage<string>();

export function runWithAccount<T>(account: string | undefined, fn: () => Promise<T>): Promise<T> {
  return account ? accountContext.run(account, fn) : fn();
}

export function getRequestedAccount(): string | undefined {
  return accountContext.getStore();
}
