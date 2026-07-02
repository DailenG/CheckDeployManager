import { createMiddleware } from "hono/factory";
import type { Env } from "./types";
import { authenticateRequest } from "./lib/access-jwt";

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
