# Staged migrations

Migrations here are not yet installed in production. The release guard compares `db/` and
`compose.yaml` with the live installation and refuses any change, so a migration enters
`db/` (with its Compose inventory line) only together with a reviewed operator rollout,
run right after the merge.

- `032_boxes.sql`: boxed sub-agents ([design](../docs/boxes.md)). The box layer is dormant;
  the migration moves into `db/` with the phase 2c rollout that first wires the layer.
