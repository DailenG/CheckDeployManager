import { Hono } from "hono";

export interface Env {
  DB: D1Database;
  STORAGE: R2Bucket;
  ASSETS: Fetcher;
  ACCESS_TEAM_DOMAIN: string;
  ACCESS_APP_AUD: string;
  ENVIRONMENT: string;
  DEV_OPERATOR_EMAIL?: string;
}

const app = new Hono<{ Bindings: Env }>();

app.get("/", (c) => c.text("CheckDeployManager"));

app.get("/manage", (c) => c.env.ASSETS.fetch(c.req.raw));
app.get("/manage/*", (c) => c.env.ASSETS.fetch(c.req.raw));

export default {
  fetch: app.fetch,
} satisfies ExportedHandler<Env>;
