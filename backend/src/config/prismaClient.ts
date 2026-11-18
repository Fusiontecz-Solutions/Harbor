import 'dotenv/config';
import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { Pool } from 'pg';

// Reuse a single PrismaClient + pg Pool across hot reloads so nodemon
// does not leak Neon connections (P1017 / ConnectionClosed).
const globalForPrisma = globalThis as unknown as {
  prisma?: PrismaClient;
  pgPool?: Pool;
  pgKeepAlive?: ReturnType<typeof setInterval>;
};

const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  throw new Error('DATABASE_URL environment variable is not set');
}

const pool =
  globalForPrisma.pgPool ??
  new Pool({
    connectionString,
    ssl: { rejectUnauthorized: false },
    keepAlive: true,
    keepAliveInitialDelayMillis: 10_000,
    // Keep pooled Neon clients warm across form-fill gaps. A short idle
    // timeout was dropping connections and forcing a TLS reconnect on create.
    idleTimeoutMillis: Number(process.env.DB_IDLE_TIMEOUT_MS ?? '300000'),
    max: Number(process.env.DB_POOL_MAX ?? '10'),
    allowExitOnIdle: true,
    // Neon cold starts can exceed 10s; allow longer connect attempts locally.
    connectionTimeoutMillis: Number(process.env.DB_CONNECTION_TIMEOUT_MS ?? '60000'),
  });

pool.on('error', (err) => {
  console.error('Database pool error:', err.message);
});

if (!globalForPrisma.pgKeepAlive) {
  globalForPrisma.pgKeepAlive = setInterval(() => {
    void pool.query('SELECT 1').catch(() => undefined);
  }, 45_000);
  globalForPrisma.pgKeepAlive.unref?.();
}

const adapter = new PrismaPg(pool);

const prisma =
  globalForPrisma.prisma ??
  new PrismaClient({
    adapter,
    log: ['error', 'warn'],
  } as any);

if (process.env.NODE_ENV !== 'production') {
  globalForPrisma.pgPool = pool;
  globalForPrisma.prisma = prisma;
}

export default prisma;
