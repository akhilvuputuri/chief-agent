# Portable capability plugins

Product requirement: [issue #37](https://github.com/akhilvuputuri/companion-agent/issues/37). The first implementation packages public research as a declarative plugin. It supports import/export between compatible Companion checkouts, namespaced agent discovery, host-granted tool access, lazy skills and durable definition pins. This is not universal Claude/Codex plugin compatibility or an MCP client implementation.

## Ownership of behavior

The host owns the conversation loop, authenticated user identity, sequential execution, cancellation, model/provider price filters, parent/child budgets, database access, approvals and report validation. Packages contain text and configuration; they cannot execute scripts, choose provider credentials, add HTTP endpoints, grant themselves tools or remove approval gates.

`src/plugins.ts` validates packages and builds immutable registries. `src/plugin-registry.ts` loads the reviewed `plugins/registry.json` at startup. `src/plugin-execution.ts` selects and pins definitions. `src/research.ts` executes the supported contract with existing owner-scoped callbacks. `src/custom-agent.ts` routes the generic `plugin_delegate` tool through that runner. Job alignment and media still use their existing specialized host profiles; they have not been converted to plugins.

A plugin agent is another isolated invocation of the same runtime. It is not an always-on service or an autonomous deployment unit. Plugin instructions are procedural guidance and cannot expand the tool allowlist. No nested delegation or parallel squads are introduced.

## Package and enabled registry

See `plugins/public-research/plugin.json` for the complete shipped example:

```text
public-research/
  plugin.json
  agents/researcher.md
  skills/source-research/SKILL.md
```

The manifest format is `companion.plugin/v1`. It declares `id`, `version`, `description`, `agents` and `skills`. IDs are lowercase words/digits separated by hyphens. Each agent declares its local ID, delegation description, instruction path, host contract, required tools, skills and execution limits. Each skill declares its local ID and path. Agent and skill identities are namespaced as `<plugin-id>/<local-id>`.

Agent instructions must live at `agents/<id>.md`; skills at `skills/<id>/SKILL.md`. This version supports a restricted Agent Skills frontmatter subset: plain single-line `name` and `description`, followed by Markdown. The name must match the skill directory. Other YAML fields/forms, references/assets/scripts, executable hooks, extra files, symlinks, unknown manifest fields and undeclared dependencies fail validation. Markdown files are limited to 32,000 UTF-8 bytes each and serialized bundles to 256 KB. Larger content should be split or supported through a future explicit contract.

The separate host registry declares enabled package directories, their exact SHA-256 content pins, enabled agent IDs and granted tools. A package cannot edit this registry by invoking a model tool. Changing installed files without updating the reviewed content pin prevents startup. Disabled agent IDs cannot be invoked even if an old task has their definition saved.

The registry also sets `researchAgent`, the agent used by the existing `research_delegate` alias. Set it to null to remove that alias. Additional compatible agents appear in `pluginCatalogue` and can be invoked using `plugin_delegate(agentId, objective, context, jobIds, urls)` without editing the conversation loop. Only enabled public research agents are exposed when web capability is configured. Package skills appear in the normal skill catalogue; contents are loaded on demand with `skill_read`.

Operator configuration can specify an optional OpenRouter `model` ID on an enabled package entry. That applies to its agents; it is absent by default, so they inherit the main model. Overrides use the existing OpenRouter adapter, medium reasoning and the same price-first routing/price ceilings. The runtime never accepts a model override from plugin text or delegation arguments. New adapters are constructed from server-side credentials only. Changing a model does not grant a larger budget. The inherited main model is not pinned by this plugin layer; actual model/provider identities remain in normal execution traces.

## Supported execution contract

`public-research/v1` is the only agent contract in this release:

- Assignment: objective, relevant context, and up to six distinct saved job IDs/public HTTPS URLs, or a general topic with no explicit targets. Host ownership and public-URL checks remain in force.
- Read capabilities: any declared subset of `web_search`, `web_read`, `source_read`, explicitly granted by the host and available in the parent session.
- Agent context: assignment only, empty conversation history/memories, compact pinned skill catalogue. Relevant skill text is loaded only when requested. The coordinator's full conversation and memories are not injected.
- Output: `research_report` with exactly one result per target, statuses complete/partial/blocked, summary and evidence. The Zod definition in `src/research-schema.ts` is authoritative.
- Evidence: complete results require evidence; exact quotations must occur in an owner-scoped source actually read by that child. These checks establish recorded support, not semantic correctness.
- Limits: at most 120 seconds, eight model calls and twenty tool calls per child, further constrained by the parent's remaining allocation. All child usage is charged to the parent once. No dollar caps are introduced.
- Side effects: source storage and execution traces are host-managed. No user-record writes, private email/Calendar access, memory saves, external messages, recursive delegation or arbitrary shell execution.

The coordinator may use its ordinary authorized tools after receiving a report. Importing a plugin does not authorize downstream changes.

## Import, export and enable

The operator CLI works without a database or API keys:

```sh
npm run plugins -- validate plugins/public-research
npm run plugins -- export plugins/public-research /tmp/public-research.bundle.json
npm run plugins -- import /tmp/public-research.bundle.json plugins/research-import
npm run plugins -- registry plugins
```

Export creates a new JSON bundle and refuses to overwrite a file. Import validates first and writes into a new destination directory; it does not enable the plugin. Review the text, then add the printed content hash and explicit agent/tool grants to the host registry. Do not enable two packages with the same plugin identity. Use a branch/PR, independent review, tests and the standard release pipeline for production changes. No install tool is exposed to the conversational agent.

Bundles export package definitions only: no private skill overrides, conversation state, memory, account configuration, host model overrides or credentials. A standalone skill's SKILL.md can be copied to another host that supports its format, but referenced tool names still need compatible implementations. Full package export requires another host that implements this manifest and `public-research/v1` contract or an adapter. Native Claude/Codex agent frontmatter, marketplaces, remote downloads and MCP-backed tools are future compatibility work; they are not silently translated.

## Task pins, private skills and rollback

On first delegation, the host resolves the enabled agent and any owner-approved private versions of its namespaced skills. It stores an immutable definition snapshot and hash in a `plugin.pinned` event associated with the coordinator run. No database migration is needed. The task linkage is through the existing owner-scoped `work_turns` records.

Later delegations in the same run or linked task reuse the earliest pin, including across process restarts and `/continue`. A new task without a pin selects the current installed definition. Pins preserve instructions, skills, package identity, limits and any explicit model override. A disabled agent or newly reduced tool grant blocks incompatible old pins instead of silently switching them. Pins with failed integrity checks pause delegation for inspection. Credential-like definition content is rejected before snapshotting so trace scrubbing cannot silently corrupt a pin. Pins are hashes, not signatures or authorization from an external publisher.

Existing non-plugin skills and their approved private revision history are unchanged. Namespaced plugin skills use the same draft/evaluate/approve flow. Only approved heads are selected, and a running task keeps the approved version it first selected. Plugin export never includes those private versions. To use an updated definition, create a new task; there is no model tool to overwrite an old pin. Roll back the installed package and registry through a reviewed commit. Old tasks still use their own pins unless revoked.

## Observability and validation

- `plugin.pinned`: private definition snapshot and definition hash, written once per selected agent/run or task.
- `plugin.selected`: package version/hash, effective definition hash, skill versions/hashes and whether the pin was reused.
- `research.child_started`: linked parent/child IDs, plugin identity, assignment and limits.
- `plugin.skill_read`: which pinned skill version the child actually loaded.
- Existing model, tool, source, usage, elapsed-time and stop-reason events remain available on the child run.

Plugin snapshots may contain approved private instructions and must remain in private trace storage. Existing bounded GitHub diagnostics still do not export full private content; this release does not install a new privileged diagnostics command.

Tests cover round-trip content identity, immutable registry copies, content pins, path/size/compatibility rejection, explicit grants, owner-isolated task pins across registry updates, private skill selection, revocation, generic delegation, lazy skills and recursive-call rejection. Existing research tests continue to cover exact targets, invented quotations, cross-user access, shared costs/budgets and cancellation. Mocked tests do not establish the quality of every imported prompt. No new infrastructure or DB/Compose changes are required; Docker includes the reviewed plugins directory.
