import { AppError } from '../lib/errors';

export type RequestBudget = { signal: AbortSignal; deadlineAt: number };
export function modelRecoveryBudget(milliseconds = 12000): RequestBudget {
  return { signal: AbortSignal.timeout(milliseconds), deadlineAt: Date.now() + milliseconds };
}
export function assertBudget(budget?: RequestBudget): void {
  if (budget && (budget.signal.aborted || Date.now() >= budget.deadlineAt)) throw new AppError('MODEL_RECOVERY_TIMEOUT', 'AI验证超时，输入已保留，请稍后重新整理', 504);
}
/** Stop callers even if a transport ignores cancellation; writes enforce the deadline in SQL too. */
export async function withinBudget<T>(work: () => PromiseLike<T>, budget?: RequestBudget): Promise<T> {
  assertBudget(budget);
  if (!budget) return work();
  let abort!: () => void;
  const cancelled = new Promise<never>((_resolve, reject) => {
    abort = () => reject(new AppError('MODEL_RECOVERY_TIMEOUT', 'AI验证超时，输入已保留，请稍后重新整理', 504));
    budget.signal.addEventListener('abort', abort, { once: true });
  });
  try {
    const result = await Promise.race([work(), cancelled]);
    assertBudget(budget); return result;
  } finally { budget.signal.removeEventListener('abort', abort); }
}
