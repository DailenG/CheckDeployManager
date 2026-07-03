import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { relayWebhookEvent, type RelayEvent } from "../src/lib/relay";
import { putInstanceSetting } from "../src/lib/db";
import { fetcherFailing, fetcherReturning, SAMPLE_GUID, SAMPLE_TENANT_NAME } from "./helpers";

function sampleEvent(): RelayEvent {
  return {
    id: "00000000-0000-4000-8000-000000000000",
    tenant_id: "00000000-0000-4000-8000-000000000000",
    tenant_name: SAMPLE_TENANT_NAME,
    guid: SAMPLE_GUID,
    received_at: "2026-07-03T00:00:00.000Z",
    event_type: "false_positive_report",
    payload_json: '{"reportType":"false_positive_report","url":"https://login.example.com"}',
  };
}

function fetcherCapturing(captured: { url?: string; body?: string }): typeof fetch {
  return (async (url: any, init: any) => {
    captured.url = String(url);
    captured.body = String(init?.body ?? "");
    return new Response("ok", { status: 200 });
  }) as typeof fetch;
}

function fetcherRefusing(): typeof fetch {
  return (async () => {
    throw new Error("relay fetch must not be called when disabled");
  }) as typeof fetch;
}

describe("webhook relay", () => {
  it("skips without calling out when no relay URL is configured", async () => {
    const outcome = await relayWebhookEvent(env, sampleEvent(), fetcherRefusing());
    expect(outcome).toEqual({ status: "skipped" });
  });

  it("POSTs the event as JSON to the configured URL", async () => {
    await putInstanceSetting(env.DB, "false_positive_relay_url", "https://hooks.example.test/relay");
    const captured: { url?: string; body?: string } = {};
    const outcome = await relayWebhookEvent(env, sampleEvent(), fetcherCapturing(captured));
    expect(outcome).toEqual({ status: "sent", httpStatus: 200 });
    expect(captured.url).toBe("https://hooks.example.test/relay");
    const sent = JSON.parse(captured.body ?? "{}");
    expect(sent.source).toBe("checkdeploymanager");
    expect(sent.kind).toBe("webhook_event");
    expect(sent.event.tenant_name).toBe(SAMPLE_TENANT_NAME);
    expect(sent.event.event_type).toBe("false_positive_report");
    // The payload travels verbatim as a string, never parsed by the relay.
    expect(typeof sent.event.payload_json).toBe("string");
  });

  it("rejects non-https relay URLs", async () => {
    await putInstanceSetting(env.DB, "false_positive_relay_url", "http://insecure.example.test/hook");
    const outcome = await relayWebhookEvent(env, sampleEvent(), fetcherRefusing());
    expect(outcome).toEqual({
      status: "failed",
      error: "relay URL must start with https://",
    });
  });

  it("reports failure on network errors and non-2xx responses", async () => {
    await putInstanceSetting(env.DB, "false_positive_relay_url", "https://hooks.example.test/relay");
    const network = await relayWebhookEvent(env, sampleEvent(), fetcherFailing());
    expect(network.status).toBe("failed");
    const http = await relayWebhookEvent(env, sampleEvent(), fetcherReturning("nope", 500));
    expect(http).toEqual({ status: "failed", error: "HTTP 500" });
  });
});
