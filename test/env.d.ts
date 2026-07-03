/// <reference types="@cloudflare/vitest-pool-workers/types" />

// Worker bindings come from the generated worker-configuration.d.ts
// (Cloudflare.Env, which types the test runner's `env` import).
// TEST_MIGRATIONS is test-only and typed in apply-migrations.ts, its single
// point of use, so the Worker Env does not carry it.
declare module "*?raw" {
  const content: string;
  export default content;
}
