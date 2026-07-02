import { Hono } from "hono";
import type { AppEnv } from "../../middleware";
import { generateArtifacts } from "../../lib/artifacts";
import { requireTenant } from "./util";

export const artifactsRoutes = new Hono<AppEnv>();

// Rendered fresh on every request; nothing generated is stored (design 1.3).
artifactsRoutes.get("/:id/artifacts", async (c) => {
  const tenant = await requireTenant(c);
  if (tenant === null) return c.json({ error: "tenant not found" }, 404);
  const result = await generateArtifacts(
    c.env,
    tenant.id,
    c.req.query("guid") ?? undefined,
  );
  if (!result.ok) return c.json({ error: result.error }, 409);
  return c.json({ artifacts: result.artifacts });
});
