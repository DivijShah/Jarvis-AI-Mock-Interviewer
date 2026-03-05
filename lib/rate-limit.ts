type RateLimitEntry = {
  count: number;
  resetAt: number;
};

type RateLimitStore = Map<string, RateLimitEntry>;

type GlobalRateLimit = typeof globalThis & {
  __jarvisRateLimitStore?: RateLimitStore;
  __jarvisRateLimitCleanupAt?: number;
};

export type ConsumeRateLimitOptions = {
  namespace: string;
  identifier: string;
  limit: number;
  windowMs: number;
};

export type ConsumeRateLimitResult = {
  allowed: boolean;
  remaining: number;
  retryAfterSeconds: number;
};

function getStore(): RateLimitStore {
  const scope = globalThis as GlobalRateLimit;
  if (!scope.__jarvisRateLimitStore) {
    scope.__jarvisRateLimitStore = new Map<string, RateLimitEntry>();
    scope.__jarvisRateLimitCleanupAt = 0;
  }
  return scope.__jarvisRateLimitStore;
}

function maybeCleanup(windowMs: number): void {
  const scope = globalThis as GlobalRateLimit;
  const now = Date.now();
  const lastCleanup = scope.__jarvisRateLimitCleanupAt || 0;
  if (now - lastCleanup < Math.min(windowMs, 60_000)) return;

  const store = getStore();
  for (const [key, value] of store.entries()) {
    if (value.resetAt <= now) {
      store.delete(key);
    }
  }
  scope.__jarvisRateLimitCleanupAt = now;
}

export function getClientIdentifier(req: Request): string {
  const forwardedFor = req.headers.get("x-forwarded-for");
  if (forwardedFor) {
    const first = forwardedFor.split(",")[0]?.trim();
    if (first) return first;
  }

  const realIp = req.headers.get("x-real-ip")?.trim();
  if (realIp) return realIp;

  const cfIp = req.headers.get("cf-connecting-ip")?.trim();
  if (cfIp) return cfIp;

  const userAgent = req.headers.get("user-agent") || "unknown-agent";
  const language = req.headers.get("accept-language") || "unknown-language";
  return `ua:${userAgent}|lang:${language}`;
}

export function consumeRateLimit(
  options: ConsumeRateLimitOptions
): ConsumeRateLimitResult {
  const limit = Math.max(1, options.limit);
  const windowMs = Math.max(1_000, options.windowMs);
  const key = `${options.namespace}:${options.identifier}`;
  const now = Date.now();
  const store = getStore();

  maybeCleanup(windowMs);

  let entry = store.get(key);
  if (!entry || entry.resetAt <= now) {
    entry = { count: 0, resetAt: now + windowMs };
  }

  entry.count += 1;
  store.set(key, entry);

  const allowed = entry.count <= limit;
  const remaining = Math.max(0, limit - entry.count);
  const retryAfterSeconds = allowed
    ? 0
    : Math.max(1, Math.ceil((entry.resetAt - now) / 1000));

  return { allowed, remaining, retryAfterSeconds };
}
