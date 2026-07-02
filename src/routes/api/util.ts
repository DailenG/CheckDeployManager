import type { Context } from "hono";
import type { AppEnv } from "../../middleware";
import { getTenant, type TenantRow } from "../../lib/db";

export async function readJsonBody(
  c: Context<AppEnv>,
): Promise<Record<string, unknown> | null> {
  try {
    const body = await c.req.json();
    if (body === null || typeof body !== "object" || Array.isArray(body)) return null;
    return body as Record<string, unknown>;
  } catch {
    return null;
  }
}

export async function requireTenant(c: Context<AppEnv>): Promise<TenantRow | null> {
  const id = c.req.param("id" as never) as string | undefined;
  if (id === undefined) return null;
  return getTenant(c.env.DB, id);
}
