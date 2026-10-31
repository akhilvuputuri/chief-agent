<div align="center">

# ◈ Chief

**Your always-on AI agent, in Telegram.**
**Ask it for anything. If it can't do it yet, it can build it.**

<!-- hero: docs/images/hero.png — a rain question answered with the radar map -->

</div>

Chief is an AI agent you message. It works through your inbox, calendar, bills, markets and
research, keeps watch while you're away, and speaks up when something needs you.

## What it does

<!-- 2 x 2 screenshot grid: calendar approval card · news topic · stock answer · Mini App canvas -->

|                        |                                                                                                                           |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| **Remembers**          | Long-running conversation, searchable history, and memory with a full revision trail. It reviews its own work every night |
| **Runs your day**      | Tasks, reminders, briefings, recurring agent work, and "keep an eye on this" monitoring                                   |
| **Inbox and calendar** | Read-only Gmail, search by meaning, parcel tracking, and calendar events created on your tap                              |
| **Money**              | Subscriptions, price-change alerts, invoice gathering, IBKR holdings and order drafts, and US stock alerts                |
| **Research**           | Sourced answers, with quotes checked against pages it actually read                                                       |
| **Reading and career** | A daily news bulletin, National Library titles and loans, role assessments, and interview preparation                     |
| **Singapore**          | Rain radar, air quality, buses, MRT, carparks, and hawker closures                                                        |
| **Voice and files**    | Voice notes, photos, and PDFs                                                                                             |

**Try:** _"Tell me when VOO closes 15% below its 52-week high."_ ·
_"Is it going to rain at my pin in the next hour?"_ ·
_"Every night at 11, research these topics and send me a sourced summary."_

## Add to it

Ask Chief for what's missing, or wire it in yourself:

| Add              | How                                                                     |
| ---------------- | ----------------------------------------------------------------------- |
| **Remote tools** | Grant individual tools from an [MCP server](docs/mcp.md)                |
| **New agents**   | Write a [declarative plugin](docs/plugins.md) with explicit tool grants |
| **Models**       | Change one [reviewed policy file](config/model-policy.json)             |

## You stay in charge

- **It asks first.** Calendar events, code merges, role deletions, and standing responsibilities wait for your approval.
- **Some things it can't do.** It can't send email, and it can't place, change, or cancel a trade.
- **Every action has limits.** Tasks are bounded, and uncertain writes pause instead of repeating.
- **You can see what it did.** Trace every turn in
  [agentwatch](https://github.com/akhilvuputuri/agentwatch).

[Security model and data handling →](docs/security.md)

## Run it

You need Node 22.19+, Docker Compose, a Telegram bot token, and an OpenRouter key. Other integrations
are optional. One deployment serves one owner. Chief installs and runs with
[Kite](https://github.com/akhilvuputuri/kite), a Rust package manager that replaces npm.

```sh
node tools/install-kite.mjs  # installs kite into ~/.local/bin
kite ci
kite run setup              # then add your two keys to .env
kite run pair               # open the link it prints and press Start
kite run pair:finish
docker compose up -d postgres && docker compose run --rm migrate
kite run dev
```

[Deployment](docs/deployment.md) · [Configuration](docs/configuration.md) ·
[Architecture](docs/architecture.md) · [Engineering journal](docs/journey/README.md) ·
[Contributing](CONTRIBUTING.md)

MIT licensed.
