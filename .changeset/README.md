# Changesets

Describe a change to the published packages with `npx changeset` (pick the bump: patch / minor / major) and commit
the generated file with your change. The release workflow turns pending changesets into a "Version Packages" pull
request; merging it publishes. See RELEASING.md.

The three `@localspeech/*` packages share one version (`fixed` in config.json). The demo app at the repository root is
private and never published.
