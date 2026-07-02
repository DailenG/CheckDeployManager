/// <reference types="@cloudflare/vitest-pool-workers/types" />

// The test runner's ProvidedEnv extends the global Cloudflare.Env, so the
// bindings are declared there. TEST_MIGRATIONS is injected by vitest.config.
declare module "*?raw" {
  const content: string;
  export default content;
}

declare namespace Cloudflare {
  interface Env {
    DB: D1Database;
    STORAGE: R2Bucket;
    ASSETS: Fetcher;
    ACCESS_TEAM_DOMAIN: string;
    ACCESS_APP_AUD: string;
    ENVIRONMENT: string;
    DEV_OPERATOR_EMAIL?: string;
    TEST_MIGRATIONS: D1Migration[];
  }
}
