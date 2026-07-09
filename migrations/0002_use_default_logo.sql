-- Explicit per-tenant opt-out of the instance default logo: 1 means the
-- tenant serves no custom logo at all, so the Check extension falls back to
-- its built-in logo even when the instance has a default logo set.
-- 0 keeps the existing behavior (tenant logo, else instance default).
ALTER TABLE tenant_branding ADD COLUMN use_default_logo INTEGER NOT NULL DEFAULT 0;
