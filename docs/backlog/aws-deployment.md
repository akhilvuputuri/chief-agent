# Deferred: operate Companion Agent on AWS

Recorded 12 September 2026. Status: backlog only. The owner is defining todos while usage quota is limited; resume when they explicitly ask. No automatic schedule, provisioning, migration or infrastructure spend is authorized by this record.

## Motivation

Gain practical AWS deployment and operations experience relevant to job applications. The aim is to operate the personal assistant and explain infrastructure, IAM, deployment, observability and recovery decisions. Avoid turning this into an oversized migration or adopting services just for a résumé. AWS is the preferred direction; GCP was considered as an alternative. Final service selection is pending a concrete costed design.

## Scope for the agent when resumed

- [ ] Inspect fresh repository and production state; preserve all user data and existing integrations.
- [ ] Prepare a modest AWS architecture and recurring-cost estimate, including compute, database, network, storage, logs and temporary overlap with DigitalOcean. Compare EC2 simplicity with ECS/Fargate managed-container experience; no final choice yet.
- [ ] Obtain account access and approval for the specific recurring spend before provisioning. The owner handles account creation/sign-in, payment, MFA/identity verification and consent. Do not request root credentials in chat.
- [ ] Define reproducible infrastructure, scoped IAM, private secret handling, networking, persistent Postgres and operational logging. Terraform, ECR, RDS, Secrets Manager and CloudWatch are candidate components, not mandatory scope.
- [ ] Set up GitHub Actions deployment with OIDC where appropriate. Preserve the workflow: PR, checks, main merge, deployment, health verification and exact release identity. Keep production credentials out of developer checkouts.
- [ ] Test using a separate Telegram bot and synthetic data. Address overlapping pollers during rollout, in-flight task interruption, uncertain writes and restart recovery.
- [ ] Plan and execute a controlled data migration/cutover after validation. Preserve roles, memories, skills, schedules, approvals, history and Google connections. Retain read-only Gmail and explicit Calendar write confirmation.
- [ ] Verify live Telegram text/voice, Google integrations, task recovery and rollback. Keep DigitalOcean available as fallback until AWS is verified; obtain authorization before retiring it.
- [ ] Update README, AGENTS.md, cloud deployment/runbooks, release notes and the development journal with actual services, checks, costs and limitations. Do not claim high availability, savings or scale without evidence.

## Boundaries

No runtime rewrite, Kubernetes, new model hosting or GPU infrastructure is required. OpenRouter and ElevenLabs can remain external providers. Finishing memory, Python trace analysis/evaluations and attachment support remain separate tasks; do not silently bundle them into migration scope. Sequence against those tasks when the owner resumes work.

## Completion evidence

Reproducible infrastructure source; scoped deployment authentication; passing checks; verified deployed SHA and health; preserved data; successful behavioral checks; documented rollback; cost estimate and observed charges clearly distinguished; an honest engineering-journal entry describing what was learned.

Next action on resumption: inspect current state and produce the costed AWS design. Do not provision directly from this backlog document.
