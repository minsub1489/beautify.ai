type Counter = {
  count: number;
  resetAt: number;
};

const WINDOW_MS = Number(process.env.BILLING_RATE_LIMIT_WINDOW_MS || '60000');
const MAX_REQUESTS = Number(process.env.BILLING_RATE_LIMIT_MAX || '30');

const counters = new Map<string, Counter>();

export function assertWithinRateLimit(userId: string, key: string) {
  const now = Date.now();
  const k = `${userId}:${key}`;
  const current = counters.get(k);

  if (!current || now >= current.resetAt) {
    counters.set(k, { count: 1, resetAt: now + WINDOW_MS });
    return;
  }

  if (current.count >= MAX_REQUESTS) {
    const retryInMs = Math.max(0, current.resetAt - now);
    const retrySec = Math.ceil(retryInMs / 1000);
    const error = new Error(`요청이 너무 많습니다. ${retrySec}초 후 다시 시도해 주세요.`) as Error & { status?: number };
    error.status = 429;
    throw error;
  }

  current.count += 1;
}
