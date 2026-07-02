// The fictional sample tenant from design section 5. This module is shared
// by the golden generation script and the golden-file tests so both always
// render from identical input. Never replace these with real client data.
import type { ArtifactInput } from "../src/lib/artifacts";

export const HARBORVIEW_ARTIFACT_INPUT: ArtifactInput = {
  guid: "f4a7c1d2-9b3e-4c8a-a1d6-2e5b7c9f0a34",
  baseUrl: "https://check.widedata.host",
  defaultCippServerUrl: "https://cipp.widedata.com",
  branding: {
    tenant_id: "harborview-sample",
    company_name: "WideData Corporation",
    product_name: "WideData Phishing Protection",
    support_email: "support@widedata.com",
    support_url: "https://support.widedata.com",
    privacy_policy_url: "https://widedata.com/privacy",
    about_url: "",
    primary_color: "#1B6FA8",
    logo_r2_key: "assets/harborview-sample/logo.png",
    logo_content_type: "image/png",
  },
  policySettings: {
    enableCippReporting: true,
    cippTenantId: "harborviewpt.onmicrosoft.com",
    urlAllowlist: [
      "https://training.knowbe4.com/*",
      "https://*.harborviewpt.com/*",
    ],
    domainSquatting: { enabled: true, deviationThreshold: 2, Action: "block" },
    genericWebhook: {
      enabled: true,
      events: ["false_positive_report", "page_blocked", "threat_detected"],
    },
  },
};
