import type { FastifyInstance } from "fastify";
import type { Portfolio } from "../portfolio.js";
import { errorFields, opsLog } from "../ops-log.js";

export const IBKR_CALLBACK_PATH = "/oauth/ibkr/callback";

const page = (message: string) =>
  `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Chief · IBKR</title><p style="font:16px system-ui;margin:2rem">${message}</p>`;

/**
 * The only public IBKR route: the OAuth redirect. It carries no session; the single-use
 * state ties the callback to the owner's attempt. Results go to the owner in Telegram.
 */
export function ibkrRoutes(
  app: FastifyInstance,
  portfolio: Portfolio,
  notify: (user: string, text: string) => Promise<void>,
) {
  app.get(IBKR_CALLBACK_PATH, async (request, reply) => {
    reply
      .header("Cache-Control", "no-store")
      .header("Referrer-Policy", "no-referrer")
      .header("X-Content-Type-Options", "nosniff")
      .type("text/html; charset=utf-8");
    const query = request.query as Record<string, unknown>;
    const text = (key: string) =>
      typeof query[key] === "string" ? (query[key] as string) : undefined;
    let result: Awaited<ReturnType<Portfolio["auth"]["complete"]>>;
    try {
      result = await portfolio.auth.complete(
        text("state") ?? "",
        text("code"),
        text("error"),
      );
    } catch (error) {
      opsLog("ibkr.callback_failed", "error", errorFields(error));
      return reply
        .code(500)
        .send(
          page(
            "Something went wrong. Return to Telegram and send /portfolio connect to try again.",
          ),
        );
    }
    opsLog("ibkr.callback", result.ok ? "info" : "warn", {
      state: result.ok ? "connected" : "rejected",
      errorCode: result.reason,
    });
    if (!result.ok) {
      if (result.user)
        await notify(
          result.user,
          result.reason === "scope_rejected"
            ? "IBKR granted more than read access, so Chief revoked it and did not connect. Nothing was saved."
            : "The IBKR connection did not complete. Send /portfolio connect to try again.",
        ).catch(() => {});
      return reply
        .code(400)
        .send(
          page(
            "The IBKR connection did not complete. Return to Telegram and send /portfolio connect to try again.",
          ),
        );
    }
    const user = result.user!;
    void portfolio
      .sync(user, "connect")
      .then(async (sync) =>
        notify(
          user,
          sync.status === "failed"
            ? `IBKR is connected with read-only access, but the first holdings sync failed (${sync.errorCode}). Send /portfolio refresh to retry.`
            : `IBKR is connected with read-only access.\n\n${(await portfolio.command(user, "show")).text}`,
        ),
      )
      .catch((error) =>
        opsLog("portfolio.first_sync_failed", "error", errorFields(error)),
      );
    return reply.send(
      page(
        "IBKR is connected with read-only access. You can close this page and return to Telegram.",
      ),
    );
  });
}
