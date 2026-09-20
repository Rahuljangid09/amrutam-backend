import { existsSync, readFileSync } from "fs";
import { parse } from "dotenv";
import { defineConfig } from "vitest/config";

// Test settings come from .env.test; CI may override the connection strings through real environment variables.
const fileEnv = existsSync(".env.test") ? parse(readFileSync(".env.test")) : {};
// CI (or a shell) can point the suites at another database with TEST_DATABASE_URL / TEST_REDIS_URL.
const overrides: Record<string, string> = {};
if (process.env.TEST_DATABASE_URL) overrides.DATABASE_URL = process.env.TEST_DATABASE_URL;
if (process.env.TEST_REDIS_URL) overrides.TEST_REDIS_URL = process.env.TEST_REDIS_URL;

export default defineConfig({
  test: {
    env: { ...fileEnv, ...overrides },
    include: ["tests/**/*.test.ts"],
    fileParallelism: false, // suites share one database
    testTimeout: 30_000,
    hookTimeout: 30_000,
    coverage: {
      provider: "v8",
      include: ["src/**"],
      exclude: ["src/scripts/**", "src/server.ts", "src/worker.ts", "src/tracing.ts"], // process entry points, exercised by the smoke test
      reporter: ["text-summary", "lcov"],
      thresholds: { lines: 80, statements: 80, functions: 80, branches: 65 },
    },
  },
});
