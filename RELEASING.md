# Releasing the @localspeech packages

The three packages (`@localspeech/core`, `@localspeech/text-to-speech`, `@localspeech/speech-to-text`) share one version
and are published to npm under the `localspeech` org. The demo app at the repository root is private and is never
published; its own version (`package.json` at the root) is bumped on every deployment instead.

## Before every release

```sh
npm ci
npm run audit:prod        # must report no high or critical advisories (CI enforces this too)
npm run typecheck
npm test
npm run pack:packages     # builds and packs into .tarballs/
```

Look at what would be published:

```sh
npm pack --dry-run -w packages/core -w packages/text-to-speech -w packages/speech-to-text
```

Each package should contain only `dist/`, `src/`, `README.md`, `LICENSE` (plus `bin/` for core and
`THIRD_PARTY_NOTICES.md` for text-to-speech).

To try the exact tarballs in another app before publishing, install them by path (core first, it is a dependency):

```sh
npm install /path/to/repo/.tarballs/localspeech-core-0.1.0.tgz /path/to/repo/.tarballs/localspeech-text-to-speech-0.1.0.tgz
```

`examples/assistant-ui-chat` does exactly this (see its README).

## First release (0.1.0) — once, by hand

1. **Review what becomes public.** Making the repository public publishes its whole history. A scan for credentials
   (keys, tokens, `.env` files) over all commits found nothing (2026-10-11).
2. **Make the GitHub repository public** (Settings → General → Danger Zone → Change visibility). npm provenance
   requires a public repository. Renaming the repository (e.g. to `localspeech`) is optional: GitHub redirects the old
   URL, but update `repository`/`homepage`/`bugs` in the three `packages/*/package.json` and re-point the Cloudflare
   Git integration.
3. **Publish**, logged in as an owner of the `localspeech` org (`npm whoami`), core first because the others depend
   on it. npm asks for your 2FA code each time:

   ```sh
   npm run build:packages
   npm publish -w packages/core
   npm publish -w packages/text-to-speech
   npm publish -w packages/speech-to-text
   ```

   `publishConfig.access` is `public` in each package, so no `--access` flag is needed.
4. **Check** https://www.npmjs.com/package/@localspeech/text-to-speech (README, version, files), and that a fresh app
   installs it: `npm install @localspeech/text-to-speech @localspeech/speech-to-text`.

## Automate later releases (once)

5. On npmjs.com, for **each** of the three packages: Settings → Trusted publishing → GitHub Actions, with
   organization/user `Alex-Cockrell`, repository `speech-model-demos` (or the new name), workflow `release.yml`.
   Then, under Publishing access, choose "Require two-factor authentication and disallow tokens".
6. In the GitHub repository: Settings → Secrets and variables → Actions → Variables → New repository variable
   `NPM_PUBLISH_ENABLED` = `true`. This switches on `.github/workflows/release.yml`.

## Every later release

1. With each change to a package, run `npx changeset`, pick the packages and the bump (patch for fixes, minor for new
   features; while at 0.x, minor may also break), write a one-line summary, and commit the file it creates.
2. On push to `main`, the Release workflow opens (or updates) a **Version packages** pull request that bumps the
   versions and writes the changelogs.
3. Merging that pull request publishes the new versions with provenance (no npm token is stored anywhere).
