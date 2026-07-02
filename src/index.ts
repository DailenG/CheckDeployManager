import { Hono } from "hono";
import { createMiddleware } from "hono/factory";
import type { Env } from "./types";
import { authenticateRequest } from "./lib/access-jwt";
import { rulesRoutes } from "./routes/rules";
import { hookRoutes } from "./routes/hook";

export type AppEnv = {
  Bindings: Env;
  Variables: { operatorEmail: string };
};

// Defense in depth: even if routing or Access configuration is ever wrong,
// the Worker itself validates the Access JWT on every management request.
export const requireOperator = createMiddleware<AppEnv>(async (c, next) => {
  const auth = await authenticateRequest(c.req.raw, c.env);
  if (!auth.ok) {
    return c.json({ error: auth.reason }, auth.status);
  }
  c.set("operatorEmail", auth.email);
  await next();
});

const app = new Hono<AppEnv>();

app.route("/", rulesRoutes);
app.route("/", hookRoutes);

app.get("/", (c) => c.redirect("/manage/"));

app.use("/manage", requireOperator);
app.use("/manage/*", requireOperator);
app.get("/manage", (c) => c.env.ASSETS.fetch(c.req.raw));
app.get("/manage/*", (c) => c.env.ASSETS.fetch(c.req.raw));

export default {
  fetch: app.fetch,
} satisfies ExportedHandler<Env>;
