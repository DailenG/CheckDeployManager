// This pool-workers release shares Miniflare storage across tests, so every
// test starts from a clean database and empty bucket via this hook.
import { env } from "cloudflare:test";
import { beforeEach } from "vitest";

const TABLES_IN_DELETE_ORDER = [
  "webhook_events",
  "revoked_guid_hits",
  "fetch_metrics",
  "audit_log",
  "upstream_snapshots",
  "instance_settings",
  "tenant_policy_settings",
  "tenant_branding",
  "ruleset_versions",
  "tenant_rule_deltas",
  "tenant_guids",
  "tenants",
];

beforeEach(async () => {
  // ruleset_versions references tenants and tenants.current_version_id
  // references ruleset_versions, so break the cycle first.
  await env.DB.prepare("UPDATE tenants SET current_version_id = NULL").run();
  for (const table of TABLES_IN_DELETE_ORDER) {
    await env.DB.prepare(`DELETE FROM ${table}`).run();
  }
  let cursor: string | undefined;
  do {
    const listing = await env.STORAGE.list({ cursor });
    if (listing.objects.length > 0) {
      await env.STORAGE.delete(listing.objects.map((object) => object.key));
    }
    cursor = listing.truncated ? listing.cursor : undefined;
  } while (cursor !== undefined);
});
