import { ConfigService } from '@nestjs/config';

/**
 * Real-Redis integration support. Set TEST_REDIS_URL (for example
 * redis://localhost:6379). When unset, the Redis specs are skipped.
 */
export const TEST_REDIS_URL = process.env.TEST_REDIS_URL;
export const describeRedis = TEST_REDIS_URL ? describe : describe.skip;

/** A ConfigService stand-in backed by a plain object. */
export function fakeConfig(values: Record<string, string>): ConfigService {
  return { get: (key: string) => values[key] } as unknown as ConfigService;
}

export const sleep = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Poll until `predicate` is true or `timeoutMs` passes. Returns elapsed ms. */
export async function waitFor(
  predicate: () => boolean | Promise<boolean>,
  timeoutMs: number,
  stepMs = 50,
): Promise<number> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (await predicate()) return Date.now() - started;
    await sleep(stepMs);
  }
  throw new Error(`condition not met within ${timeoutMs}ms`);
}
