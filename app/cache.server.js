const globalCache = global.__backorderOpsCache || {
  values: new Map(),
  pending: new Map(),
};

global.__backorderOpsCache = globalCache;

export async function getCachedValue(key, ttlMs, producer, { force = false } = {}) {
  const now = Date.now();
  const cached = globalCache.values.get(key);

  if (!force && cached && cached.expiresAt > now) {
    return {
      value: cached.value,
      cached: true,
      cachedAt: cached.cachedAt,
    };
  }

  if (!force && globalCache.pending.has(key)) {
    const pendingValue = await globalCache.pending.get(key);
    return {
      value: pendingValue,
      cached: true,
      cachedAt: globalCache.values.get(key)?.cachedAt || new Date().toISOString(),
    };
  }

  const pending = Promise.resolve().then(producer);
  globalCache.pending.set(key, pending);

  try {
    const value = await pending;
    const cachedAt = new Date().toISOString();
    globalCache.values.set(key, {
      value,
      cachedAt,
      expiresAt: now + ttlMs,
    });

    return {
      value,
      cached: false,
      cachedAt,
    };
  } finally {
    globalCache.pending.delete(key);
  }
}
