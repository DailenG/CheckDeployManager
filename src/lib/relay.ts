// Outbound relay for inbound webhook reports (false positives and similar).
// When the false_positive_relay_url instance setting is set, every stored
// webhook event is POSTed to it as JSON, so operators can trigger n8n,
// Power Automate, or comparable automations (tickets, notifications).
//
// Delivery is best effort: one attempt inside waitUntil, no queue and no
// retry, matching the zero-infrastructure design. The extension retries
// nothing either; the inbox row is the durable record and the relay is a
// convenience copy. payload_json is forwarded verbatim as a string, never
// parsed or interpreted here; receivers must treat it as hostile input.
import type { Env } from "../types";
import { getInstanceSettings } from "./db";

export interface RelayEvent {
  id: string;
  tenant_id: string;
  tenant_name: string;
  guid: string;
  received_at: string;
  event_type: string;
  payload_json: string;
}

export type RelayOutcome =
  | { status: "skipped" }
  | { status: "sent"; httpStatus: number }
  | { status: "failed"; error: string };

export async function relayWebhookEvent(
  env: Env,
  event: RelayEvent,
  fetcher: typeof fetch = fetch,
): Promise<RelayOutcome> {
  const settings = await getInstanceSettings(env.DB);
  const url = (settings.false_positive_relay_url ?? "").trim();
  if (url === "") return { status: "skipped" };
  if (!/^https:\/\//i.test(url)) {
    return { status: "failed", error: "relay URL must start with https://" };
  }
  try {
    const response = await fetcher(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        source: "checkdeploymanager",
        kind: "webhook_event",
        event,
      }),
    });
    if (!response.ok) {
      return { status: "failed", error: `HTTP ${response.status}` };
    }
    return { status: "sent", httpStatus: response.status };
  } catch (error) {
    return { status: "failed", error: String(error) };
  }
}
