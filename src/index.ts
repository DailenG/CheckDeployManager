import { Hono } from "hono";
import type { Env } from "./types";
import { rulesRoutes } from "./routes/rules";
import { hookRoutes } from "./routes/hook";

const app = new Hono<{ Bindings: Env }>();

app.route("/", rulesRoutes);
app.route("/", hookRoutes);

app.get("/", (c) => c.redirect("/manage/"));

app.get("/manage", (c) => c.env.ASSETS.fetch(c.req.raw));
app.get("/manage/*", (c) => c.env.ASSETS.fetch(c.req.raw));

export default {
  fetch: app.fetch,
} satisfies ExportedHandler<Env>;
