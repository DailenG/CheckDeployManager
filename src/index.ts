import { Hono } from "hono";
import type { Env } from "./types";
import { requireOperator, type AppEnv } from "./middleware";
import { rulesRoutes } from "./routes/rules";
import { hookRoutes } from "./routes/hook";
import { apiRoutes } from "./routes/api";
import { runScheduledTasks } from "./lib/cron";

const app = new Hono<AppEnv>();

app.route("/", rulesRoutes);
app.route("/", hookRoutes);
app.route("/api", apiRoutes);

app.get("/", (c) => c.redirect("/manage/"));

app.use("/manage", requireOperator);
app.use("/manage/*", requireOperator);
app.get("/manage", (c) => c.env.ASSETS.fetch(c.req.raw));
app.get("/manage/*", (c) => c.env.ASSETS.fetch(c.req.raw));

export default {
  fetch: app.fetch,
  scheduled: async (controller, env, ctx) => {
    ctx.waitUntil(
      (async () => {
        const { sync, cleanup } = await runScheduledTasks(env);
        console.log(
          "cron complete:",
          JSON.stringify({ sync: sync.status, diff: sync.diffSummary, cleanup }),
        );
      })(),
    );
  },
} satisfies ExportedHandler<Env>;
