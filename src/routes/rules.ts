// Public runtime endpoints: /rules/{guid}.json, /preview/{token}.json, and
// /assets/{guid}/logo. No auth here by design; unguessable identifiers are
// the control, and every miss is a uniform bare 404 (design 3.1).
import { Hono } from "hono";
import type { Env } from "../types";
import {
  countFetchHit,
  countRevokedHit,
  getCurrentVersion,
  getDraftDelta,
  getGuid,
} from "../lib/db";
import { buildMergedRuleset, formatEtagHeader } from "../lib/publish";

const CORS_HEADERS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, HEAD, OPTIONS",
};

function bare404(): Response {
  return new Response(null, { status: 404 });
}

function rulesHeaders(etagHash: string): Headers {
  const headers = new Headers(CORS_HEADERS);
  headers.set("Content-Type", "application/json; charset=utf-8");
  headers.set("Cache-Control", "public, max-age=300");
  headers.set("ETag", formatEtagHeader(etagHash));
  headers.set("X-Content-Type-Options", "nosniff");
  return headers;
}

export const rulesRoutes = new Hono<{ Bindings: Env }>();

rulesRoutes.options("/rules/:file", () => {
  return new Response(null, { status: 204, headers: CORS_HEADERS });
});

rulesRoutes.on(["GET", "HEAD"], "/rules/:file", async (c) => {
  const file = c.req.param("file");
  if (!file.endsWith(".json")) return bare404();
  const guid = file.slice(0, -".json".length);

  // Single indexed lookup for unknown and revoked alike, so response timing
  // does not distinguish the two for enumeration probes.
  const guidRow = await getGuid(c.env.DB, guid);
  if (guidRow === null) return bare404();
  if (guidRow.status !== "active") {
    await countRevokedHit(c.env.DB, guid);
    return bare404();
  }

  const version = await getCurrentVersion(c.env.DB, guidRow.tenant_id);
  if (version === null) return bare404();

  const headers = rulesHeaders(version.etag);
  const etagHeader = formatEtagHeader(version.etag);
  const ifNoneMatch = c.req.header("If-None-Match");
  if (
    ifNoneMatch !== undefined &&
    ifNoneMatch
      .split(",")
      .map((v) => v.trim().replace(/^W\//, ""))
      .includes(etagHeader)
  ) {
    await countFetchHit(c.env.DB, guidRow.tenant_id, guid, true);
    return new Response(null, { status: 304, headers });
  }

  await countFetchHit(c.env.DB, guidRow.tenant_id, guid, false);
  if (c.req.method === "HEAD") {
    return new Response(null, { status: 200, headers });
  }
  const object = await c.env.STORAGE.get(version.r2_key);
  if (object === null) return bare404();
  return new Response(object.body, { status: 200, headers });
});

rulesRoutes.get("/preview/:file", async (c) => {
  const file = c.req.param("file");
  if (!file.endsWith(".json")) return bare404();
  const token = file.slice(0, -".json".length);

  const tenant = await c.env.DB.prepare(
    "SELECT id FROM tenants WHERE preview_token = ?",
  )
    .bind(token)
    .first<{ id: string }>();
  if (tenant === null) return bare404();

  const draft = await getDraftDelta(c.env.DB, tenant.id);
  const lastVersion = await c.env.DB.prepare(
    "SELECT MAX(version_number) AS max_version FROM ruleset_versions WHERE tenant_id = ?",
  )
    .bind(tenant.id)
    .first<{ max_version: number | null }>();
  const built = await buildMergedRuleset(
    c.env,
    draft,
    (lastVersion?.max_version ?? 0) + 1,
  );
  if (!built.ok) {
    return c.json(
      { errors: built.errors },
      422,
      { "Cache-Control": "no-store", ...CORS_HEADERS },
    );
  }
  return c.json(built.merged as Record<string, unknown>, 200, {
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    ...CORS_HEADERS,
  });
});

rulesRoutes.get("/assets/:guid/logo", async (c) => {
  const guidRow = await getGuid(c.env.DB, c.req.param("guid"));
  if (guidRow === null || guidRow.status !== "active") return bare404();

  const branding = await c.env.DB.prepare(
    "SELECT logo_r2_key, logo_content_type FROM tenant_branding WHERE tenant_id = ?",
  )
    .bind(guidRow.tenant_id)
    .first<{ logo_r2_key: string | null; logo_content_type: string | null }>();
  let logoKey = branding?.logo_r2_key ?? null;
  let logoContentType = branding?.logo_content_type ?? null;

  // Tenants without their own logo inherit the instance default: the
  // per-tenant URL stays stable while the content inherits. Read the two
  // keys directly rather than via getInstanceSettings, which seeds missing
  // defaults; this unauthenticated route must never write.
  if (logoKey === null) {
    const { results } = await c.env.DB.prepare(
      "SELECT key, value FROM instance_settings " +
        "WHERE key IN ('default_logo_r2_key', 'default_logo_content_type')",
    ).all<{ key: string; value: string }>();
    const settings = Object.fromEntries(results.map((row) => [row.key, row.value]));
    if (settings.default_logo_r2_key) {
      logoKey = settings.default_logo_r2_key;
      logoContentType = settings.default_logo_content_type || null;
    }
  }
  if (logoKey === null) return bare404();

  const object = await c.env.STORAGE.get(logoKey);
  if (object === null) return bare404();
  return new Response(object.body, {
    status: 200,
    headers: {
      "Content-Type": logoContentType ?? "application/octet-stream",
      "Cache-Control": "public, max-age=86400",
      "X-Content-Type-Options": "nosniff",
      ...CORS_HEADERS,
    },
  });
});
