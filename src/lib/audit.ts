import { newId, nowIso } from "./db";

// Writes one audit row. Operator is the verified Access email, the dev
// bypass identity, or the literal string 'cron' for scheduled work.
export async function writeAudit(
  db: D1Database,
  operatorEmail: string,
  action: string,
  tenantId: string | null,
  details: unknown,
): Promise<void> {
  await db
    .prepare(
      "INSERT INTO audit_log (id, ts, operator_email, action, tenant_id, details_json) " +
        "VALUES (?, ?, ?, ?, ?, ?)",
    )
    .bind(
      newId(),
      nowIso(),
      operatorEmail,
      action,
      tenantId,
      details === undefined ? null : JSON.stringify(details),
    )
    .run();
}
