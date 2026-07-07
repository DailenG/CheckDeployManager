import path from "node:path";
import { defineConfig } from "vitest/config";
import {
  cloudflareTest,
  readD1Migrations,
} from "@cloudflare/vitest-pool-workers";

export default defineConfig({
  plugins: [
    cloudflareTest(async () => {
      const migrations = await readD1Migrations(
        path.join(__dirname, "migrations"),
      );
      return {
        wrangler: { configPath: "./wrangler.jsonc" },
        miniflare: {
          bindings: {
            TEST_MIGRATIONS: migrations,
            ENVIRONMENT: "production",
            // Deploy-button copies carry real values in wrangler.jsonc vars;
            // pin the unconfigured state so the fail-closed tests pass in
            // every copy, not only in the upstream repo.
            ACCESS_TEAM_DOMAIN: "",
            ACCESS_APP_AUD: "",
          },
        },
      };
    }),
  ],
  test: {
    setupFiles: ["./test/apply-migrations.ts", "./test/reset.ts"],
    // Storage is shared across the Miniflare instance, so test files must
    // not run concurrently.
    fileParallelism: false,
  },
});
