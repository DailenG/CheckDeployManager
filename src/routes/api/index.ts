import { Hono } from "hono";
import { requireOperator, type AppEnv } from "../../middleware";
import { tenantsRoutes } from "./tenants";
import { rulesApiRoutes } from "./rules";
import { brandingRoutes } from "./branding";
import { policyRoutes } from "./policy";
import { guidRevokeRoutes, guidsRoutes } from "./guids";
import { instanceRoutes } from "./instance";
import { upstreamRoutes } from "./upstream";
import { eventsRoutes } from "./events";
import { auditRoutes } from "./audit";

export const apiRoutes = new Hono<AppEnv>();

apiRoutes.use("*", requireOperator);

apiRoutes.route("/tenants", tenantsRoutes);
apiRoutes.route("/tenants", rulesApiRoutes);
apiRoutes.route("/tenants", brandingRoutes);
apiRoutes.route("/tenants", policyRoutes);
apiRoutes.route("/tenants", guidsRoutes);
apiRoutes.route("/guids", guidRevokeRoutes);
apiRoutes.route("/instance", instanceRoutes);
apiRoutes.route("/upstream", upstreamRoutes);
apiRoutes.route("/events", eventsRoutes);
apiRoutes.route("/audit", auditRoutes);
