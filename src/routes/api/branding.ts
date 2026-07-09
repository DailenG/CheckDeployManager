import { Hono } from "hono";
import type { AppEnv } from "../../middleware";
import { writeAudit } from "../../lib/audit";
import { getInstanceSettings } from "../../lib/db";
import { parseTenantDefaults } from "../../lib/tenant-defaults";
import { requireTenant } from "./util";

export const MAX_LOGO_BYTES = 512 * 1024;

export const LOGO_TYPES: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/svg+xml": "svg",
};

const TEXT_FIELDS = [
  "company_name",
  "product_name",
  "support_email",
  "support_url",
  "privacy_policy_url",
  "about_url",
  "primary_color",
];

export const brandingRoutes = new Hono<AppEnv>();

brandingRoutes.get("/:id/branding", async (c) => {
  const tenant = await requireTenant(c);
  if (tenant === null) return c.json({ error: "tenant not found" }, 404);
  const branding = await c.env.DB.prepare(
    "SELECT * FROM tenant_branding WHERE tenant_id = ?",
  )
    .bind(tenant.id)
    .first();
  const settings = await getInstanceSettings(c.env.DB);
  return c.json({
    branding,
    // Instance-level defaults, so the dashboard can mark inherited fields.
    defaults: parseTenantDefaults(settings.tenant_defaults ?? "").branding,
    default_logo: settings.default_logo_r2_key !== "",
  });
});

// Accepts JSON for text fields, or multipart/form-data when a logo file is
// included. Logo constraints per design 3.2: png/jpg/svg, 512 KB cap.
brandingRoutes.put("/:id/branding", async (c) => {
  const tenant = await requireTenant(c);
  if (tenant === null) return c.json({ error: "tenant not found" }, 404);

  const contentType = c.req.header("Content-Type") ?? "";
  let fields: Record<string, string> = {};
  let logo: File | null = null;
  let removeLogo = false;
  // true pins the tenant to the Check extension's built-in logo (no custom
  // logo, no instance-default inheritance); false returns to inheriting.
  let useDefaultLogo: boolean | undefined;

  if (contentType.toLowerCase().startsWith("multipart/form-data")) {
    const form = await c.req.formData();
    for (const key of TEXT_FIELDS) {
      const value = form.get(key);
      if (typeof value === "string") fields[key] = value;
    }
    const file = form.get("logo");
    if (file instanceof File) logo = file;
    if (form.get("remove_logo") === "true") removeLogo = true;
    const flag = form.get("use_default_logo");
    if (flag === "true") useDefaultLogo = true;
    else if (flag === "false") useDefaultLogo = false;
  } else {
    let body: Record<string, unknown>;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "invalid JSON body" }, 400);
    }
    for (const key of TEXT_FIELDS) {
      if (typeof body[key] === "string") fields[key] = body[key] as string;
    }
    if (body.remove_logo === true) removeLogo = true;
    if (typeof body.use_default_logo === "boolean") {
      useDefaultLogo = body.use_default_logo;
    }
  }

  let logoR2Key: string | null | undefined;
  let logoContentType: string | null | undefined;
  if (logo !== null) {
    const extension = LOGO_TYPES[logo.type];
    if (extension === undefined) {
      return c.json({ error: "logo must be png, jpg, or svg" }, 400);
    }
    if (logo.size > MAX_LOGO_BYTES) {
      return c.json({ error: "logo exceeds 512 KB" }, 413);
    }
    logoR2Key = `assets/${tenant.id}/logo.${extension}`;
    logoContentType = logo.type;
    await c.env.STORAGE.put(logoR2Key, await logo.arrayBuffer(), {
      httpMetadata: { contentType: logo.type },
    });
  } else if (removeLogo || useDefaultLogo === true) {
    const existing = await c.env.DB.prepare(
      "SELECT logo_r2_key FROM tenant_branding WHERE tenant_id = ?",
    )
      .bind(tenant.id)
      .first<{ logo_r2_key: string | null }>();
    if (existing?.logo_r2_key) await c.env.STORAGE.delete(existing.logo_r2_key);
    logoR2Key = null;
    logoContentType = null;
  }

  // Uploading a custom logo or plain removal (back to inheriting) both clear
  // the opt-out; an explicit use_default_logo value states it outright.
  let useDefaultFlag: number | undefined;
  if (useDefaultLogo !== undefined) useDefaultFlag = useDefaultLogo ? 1 : 0;
  if (logo !== null || (removeLogo && useDefaultLogo === undefined)) {
    useDefaultFlag = 0;
  }

  const assignments: string[] = [];
  const bindings: unknown[] = [];
  for (const [key, value] of Object.entries(fields)) {
    assignments.push(`${key} = ?`);
    bindings.push(value);
  }
  if (logoR2Key !== undefined) {
    assignments.push("logo_r2_key = ?", "logo_content_type = ?");
    bindings.push(logoR2Key, logoContentType);
  }
  if (useDefaultFlag !== undefined) {
    assignments.push("use_default_logo = ?");
    bindings.push(useDefaultFlag);
  }
  if (assignments.length > 0) {
    bindings.push(tenant.id);
    await c.env.DB.prepare(
      `UPDATE tenant_branding SET ${assignments.join(", ")} WHERE tenant_id = ?`,
    )
      .bind(...bindings)
      .run();
  }
  await writeAudit(c.env.DB, c.get("operatorEmail"), "branding.update", tenant.id, {
    fields: Object.keys(fields),
    logoUpdated: logo !== null,
    logoRemoved: removeLogo,
    ...(useDefaultLogo !== undefined ? { useDefaultLogo } : {}),
  });
  const branding = await c.env.DB.prepare(
    "SELECT * FROM tenant_branding WHERE tenant_id = ?",
  )
    .bind(tenant.id)
    .first();
  return c.json({ ok: true, branding });
});
