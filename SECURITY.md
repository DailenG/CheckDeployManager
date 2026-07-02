# Security Policy

## Reporting a vulnerability

Please report suspected vulnerabilities privately via GitHub Security Advisories on this repository (Security > Report a vulnerability). Do not open public issues for security reports. You should receive a response within a few business days.

## Threat model summary

The full threat model lives in [docs/architecture.md](docs/architecture.md) section 8. The assets worth protecting are the integrity of served detection rules, the confidentiality of the tenant-to-client mapping, operator access, and webhook payload contents.

| Threat | Mitigations |
|---|---|
| Rules poisoning | Cloudflare Access in front of all management surfaces; independent JWT re-validation inside the Worker that fails closed; immutable versioning with one-click rollback; validation gates on every publish; indefinite audit log |
| Tenant enumeration | 128-bit random GUIDs; uniform bare 404 for unknown and revoked GUIDs alike; no readable slugs on any public path; revoked-hit counters for detection; WAF rate limiting recommended |
| Client identity leakage | Public paths carry only GUIDs; tenant names exist only behind Access |
| Upstream compromise or breakage | Validation gates before any republish; a failing snapshot never replaces the last good one; diff summaries and dashboard flags; per tenant rollback |
| Webhook abuse | 256 KB body cap; content-type enforcement; payloads stored verbatim but always HTML-escaped on render and never interpreted; retention limits |
| DoS / quota exhaustion | Cloudflare absorbs volumetric attacks; the failure mode is extensions falling back to cached rules, which degrades gracefully |
| Access misconfiguration | The Worker validates the Access JWT itself, so an unprotected route never exposes the API; unset Access variables reject all management requests |

## Design properties

- **Zero secrets.** v1 requires no Worker secrets, no API keys, and no passwords. `ACCESS_TEAM_DOMAIN` and `ACCESS_APP_AUD` are non-secret identifiers.
- **Fail closed.** Production auth rejects everything until Access is configured. The local development bypass activates only when `ENVIRONMENT=development`, which is never set in production configuration.
- **Hostile-data handling.** Webhook payloads are untrusted end to end: size-capped on ingest, stored as opaque strings, HTML-escaped on every render, never executed or interpreted.
- **Privacy.** Fetch metrics store GUID-level counters only. Webhook payloads follow configurable retention (90 days by default, or immediately after disposition). The audit log stores operator emails only.
