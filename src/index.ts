import { Hono } from "hono";
import type { Env } from "./types";
import { requireOperator, type AppEnv } from "./middleware";
import { rulesRoutes } from "./routes/rules";
import { hookRoutes } from "./routes/hook";
import { apiRoutes } from "./routes/api";
import { runScheduledTasks } from "./lib/cron";
import exportGpoConfigScript from "../scripts/Export-CheckGpoConfig.ps1";

const app = new Hono<AppEnv>();

app.route("/", rulesRoutes);
app.route("/", hookRoutes);
app.route("/api", apiRoutes);

app.get("/", (c) => c.redirect("/manage/"));

app.use("/manage", requireOperator);
app.use("/manage/*", requireOperator);
// The GPO-migration helper script, bundled from scripts/ at build time so
// the onboarding wizard can offer it as a download; behind the same
// operator gate as the rest of the dashboard.
app.get("/manage/export-checkgpoconfig.ps1", (c) =>
  c.body(exportGpoConfigScript, 200, {
    "Content-Type": "text/plain; charset=utf-8",
    "Content-Disposition": 'attachment; filename="Export-CheckGpoConfig.ps1"',
  }),
);
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
