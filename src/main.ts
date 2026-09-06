import { SheetsTools } from "./sheets.js";
import { GmailTools } from "./gmail.js";
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
  new JobTools(
    db,
    new WebTools(c.TAVILY_API_KEY, c.OPENROUTER_API_KEY, c.HERMES_MODEL),
    new GmailTools({
      owner: c.GMAIL_OWNER_USER_ID,
      email: c.GMAIL_EMAIL,
      clientId: c.GOOGLE_CLIENT_ID,
      clientSecret: c.GOOGLE_CLIENT_SECRET,
      refreshToken: c.GOOGLE_REFRESH_TOKEN,
    }),
    new SheetsTools(db, {
      owner: c.SHEETS_OWNER_USER_ID,
      clientId: c.GOOGLE_CLIENT_ID,
      clientSecret: c.GOOGLE_CLIENT_SECRET,
      refreshToken: c.SHEETS_REFRESH_TOKEN,
      spreadsheetId: c.SHEETS_SPREADSHEET_ID,
    }),
  ),
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
