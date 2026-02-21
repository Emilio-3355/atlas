import Redis from 'ioredis';
import { getEnv } from './env.js';

let redis: Redis | null = null;

export function getRedis(): Redis {
  if (!redis) {
    redis = new Redis(getEnv().REDIS_URL, {
      maxRetriesPerRequest: 3,
      retryStrategy(times) {
        return Math.min(times * 200, 5000);
      },
      lazyConnect: true,
    });

    redis.on('error', (err) => {
      console.error('Redis error:', err.message);
    });
  }
  return redis;
}

export async function connectRedis(): Promise<void> {
  const r = getRedis();
  if (r.status !== 'ready') {
    await r.connect();
  }
}

export async function closeRedis(): Promise<void> {
  if (redis) {
    await redis.quit();
    redis = null;
  }
}

// JSON helpers
export async function setJSON(key: string, value: any, ttlSeconds?: number): Promise<void> {
  const r = getRedis();
  const json = JSON.stringify(value);
  if (ttlSeconds) {
    await r.setex(key, ttlSeconds, json);
  } else {
    await r.set(key, json);
  }
}

export async function getJSON<T = any>(key: string): Promise<T | null> {
  const r = getRedis();
  const val = await r.get(key);
  if (!val) return null;
  return JSON.parse(val) as T;
}
