// The fictional sample tenant from design section 5. This module is shared
// by the golden generation script and the golden-file tests so both always
// render from identical input. The operator is the fictional "Example MSP";
// Harborview Physical Therapy is its fictional client. Never replace these
// with real data.
import type { ArtifactInput } from "../src/lib/artifacts";

export const HARBORVIEW_ARTIFACT_INPUT: ArtifactInput = {
  guid: "f4a7c1d2-9b3e-4c8a-a1d6-2e5b7c9f0a34",
  baseUrl: "https://check.example.com",
  defaultCippServerUrl: "https://cipp.example.com",
  branding: {
    tenant_id: "harborview-sample",
    company_name: "Example MSP",
    product_name: "Example MSP Phishing Protection",
    support_email: "support@example.com",
    support_url: "https://support.example.com",
    privacy_policy_url: "https://example.com/privacy",
    about_url: "",
    primary_color: "#1B6FA8",
    logo_r2_key: "assets/harborview-sample/logo.png",
    logo_content_type: "image/png",
    use_default_logo: 0,
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
