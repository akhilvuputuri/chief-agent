# MCP migration 030 and credential setup

This first release changes Compose and adds `db/030_mcp.sql`; the ordinary
release handler must refuse it until a reviewed operator installs the baseline.
Use the existing authorized Lightsail operator connection. Never export production
credentials into a development checkout or alter the restricted release command.

## Prerequisites

Require exact-head independent approval and passing full CI. Fetch current main
and verify the live RELEASE/health before installation. Serialize against the
normal `/var/lock/companion-release.lock`. Verify all historical migration bytes
against the deployed baseline; the only database addition is 030. Compose changes
are limited to adding 030 to the migration inventory and passing two MCP settings.
Do not invoke the historical migration service as an upgrade operation.

Transfer only the reviewed source archive to private host scratch. Verify its
checksum against the local reviewed Git archive. Build the candidate image with
its exact SHA before changing live services. Preserve the previous image and a
root-only backup of the existing Compose/source baseline and RELEASE. Record
bounded preservation counts for existing user records and runtime state, without
private content. Confirm zero running runtime runs and zero queued/running inputs.
Do not cancel work or resume paused tasks to create an idle window.

## Install disabled first

Hold the release lock and recheck the live SHA and idle counts. Stop only gateway,
then recheck the counts through Postgres. If work arrived, restart the previous
gateway and defer. Apply only `db/030_mcp.sql` with `psql -v ON_ERROR_STOP=1` to
the existing database. Require marker 30 and the expected operation table/index.
No existing data is reset or migrated.

Install the reviewed source/Compose and candidate image, preserving `.env`,
managed volumes, other credentials and flags. Leave MCP off; an existing
MCP_RUNTIME value must be explicitly checked rather than accidentally enabled.
Start only gateway using `--no-deps --no-build`. Verify embedded release SHA,
localhost health, marker 30, disabled MCP and preservation counts. Update RELEASE
only after these checks pass. Release the operator lock, then watch the normal
GitHub release and its exact-commit receipt against the installed DB/Compose
baseline. Neither the operator image nor CI alone establishes normal deployment.

On failure, restore the previous image/source/Compose and verify its health and
RELEASE. Retain additive migration 030 and any MCP operation journal; never drop
tables, remove volumes or overwrite the full environment with a stale backup.
Record the failure rather than publishing a shipped version.

## Activate a connection

The owner creates a labelled API credential in Reader Settings → Assistant
connections. Install it directly into the owner-only host environment as the
`reader` reference with the correct Telegram owner. Keep all values out of terminal
output, shell history and chat. Enable MCP only after migration 030 and matching
owner configuration; recreate only gateway during an idle, serialized window.

Check discovery and then save a public article and a clearly labelled sourced
brief from Telegram. Record IDs and terminal server status privately; report only
bounded outcomes publicly. Retry an identical operation and simulate an uncertain
response with the original key. Confirm the phone separately reaches Available
offline. Revoke the connection in Reader Settings and verify unchanged attempts
stop. No model or provider claim substitutes for these acceptance checks.

Replacing a credential creates a different server connection identity. Do not
replay old pending document saves under a replacement token. If the old connection
is revoked with an uncertain operation, inspect its disposition in the phone app;
an authorized operator must document and settle the old journal row before new
writes. Keep the original payload/key and outcome evidence. Disabling MCP does
not settle pending writes; inspect them before reactivation.

Cloud development and mocks require no credentials. Ordinary later code-only
changes use the shared release pipeline. Initial schema/Compose installation and
credential setup remain operator steps; OAuth connect/reconnect is the next
milestone for reducing this access gap.
