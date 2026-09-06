import { readConfig } from "./config.js";
import { connect } from "./db.js";
import { JobTools } from "./tools.js";
import { WebTools } from "./providers.js";
import { Assistant, Hermes } from "./agent.js";
import { server } from "./server.js";
import { telegram } from "./telegram.js";
const c = readConfig();
const db = connect(c.DATABASE_URL);
await db.query("SELECT 1");
const assistant = new Assistant(
  db,
  new Hermes(c.HERMES_URL, c.INTERNAL_API_TOKEN),
  new JobTools(db, new WebTools(c.TAVILY_API_KEY)),
);
const app = server(assistant, c.INTERNAL_API_TOKEN);
const bot = telegram(c, assistant, db);
await app.listen({ host: "0.0.0.0", port: c.PORT });
for (const signal of ["SIGINT", "SIGTERM"])
  process.once(signal, () => {
    void (async () => {
      if (bot.isRunning()) await bot.stop();
      await app.close();
      await db.end();
    })();
  });
await bot.start({
  allowed_updates: ["message"],
  onStart: () => console.log(JSON.stringify({ event: "gateway.started" })),
});
