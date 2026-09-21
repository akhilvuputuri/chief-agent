# Chief naming and compatibility

The product is **Chief**, and the canonical repository is `akhilvuputuri/chief-agent` (formerly `companion-agent`). The same repository retains its issues, PRs, history, releases, settings and stable repository ID `1358822022`. GitHub redirects historical links; update checkout remotes to the canonical URL:

```sh
git remote set-url origin https://github.com/akhilvuputuri/chief-agent.git
```

Existing server/local paths, Docker project and volumes, database/user names, secrets (`COMPANION_*`), Calendar idempotency metadata, Mini App session derivation, `companion.plugin*` formats and private approved plugin pins retain their identifiers. They are compatibility contracts, not display names. No account relinking or database migration is part of this change. Previously created Sheets and old Telegram messages retain their original titles.

The `/companion diagnose` cloud command and `companion/production` receipt context remain supported operational names; existing Devin shortcuts continue to work. Deployment evidence validates the stable repository ID as well as the allowed historical/current names. Diagnostics validates repository ID, private visibility, actor and exact command. Do not create another repository at the old slug.

Update external repository integrations after the rename: verify Devin's repository enrollment and future-task checkout selection, plus the actual auto-review check. The existing Telegram bot username/deep links and OAuth consent application's registered name remain stable. The bot display name/description can change without replacing its token or pairing. Static OAuth information pages under `ops/oauth-site` require a separate operator copy; ordinary app deployment does not install them or change Google consent settings.

## Release checklist

- Review current main, run checks, independent review, merge.
- Rename the existing private GitHub repository; update the local remote and description.
- Verify the exact main release and historical receipt lookup under the new repository URL.
- Verify Mini App branding, Telegram display metadata and external integrations. Report any unverified external settings explicitly.
- Publish the next patch tag only after successful deployment. Context-budget remediation is separate (issue #77).
