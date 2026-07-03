import { applyD1Migrations, env, type D1Migration } from "cloudflare:test";

// TEST_MIGRATIONS is injected by vitest.config for the test runner only, so
// it is typed here at its single point of use rather than on the Worker Env.
const testEnv = env as typeof env & { TEST_MIGRATIONS: D1Migration[] };

await applyD1Migrations(testEnv.DB, testEnv.TEST_MIGRATIONS);
