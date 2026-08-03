# Fork publishing to GitHub Packages

**Date:** 2026-08-03
**Status:** Approved

## Goal

Let CommandCenterApp consume this fork's (`DavidRoyBlue/likec4`) packages — including the
diagram-editor features not yet released upstream — as installable npm packages from
GitHub Packages (`npm.pkg.github.com`), published automatically from the `command-center`
branch.

## Constraints

- GitHub Packages requires the npm scope to match the repo owner, so `@likec4/*` and the
  unscoped `likec4` cannot be published from this fork as-is. Names are rewritten to
  `@davidroyblue/*` **at publish time only**; source stays untouched to avoid merge
  friction with upstream.
- `@likec4/react` and `@likec4/vite-plugin` are private upstream; their functionality ships
  inside the `likec4` package via the `likec4/react` and `likec4/vite-plugin` subpath
  exports. No private flags are flipped.
- The publish set is every non-private workspace package: 13 under `packages/*` plus
  `@likec4/styles` and `@likec4/style-preset` under `styled-system/*`.

## Components

### 1. Rename script — `devops/prepare-fork-publish.mjs`

Run only in CI, after build, before publish. For each public workspace package:

- Rename `likec4` → `@davidroyblue/likec4` and `@likec4/x` → `@davidroyblue/x`.
  The scope is derived from `GITHUB_REPOSITORY` (lowercased owner), overridable via CLI flag.
- Stamp version as `<current>-cc.<run>` where `<run>` is `GITHUB_RUN_NUMBER`
  (e.g. `1.59.2-cc.7`; `@likec4/icons` keeps its own base version).
- Rewrite inter-package dependency keys in `dependencies`, `devDependencies`,
  `peerDependencies`, and `optionalDependencies` to the renamed names. `workspace:*`
  ranges are kept (pnpm replaces them with the stamped exact version on publish);
  non-workspace ranges are replaced with the stamped exact version.
- Set `repository.url` to the fork (GitHub Packages links packages to the repo via this
  field and can reject mismatches).
- Set `publishConfig.registry` to `https://npm.pkg.github.com` and delete
  `publishConfig.access` (visibility follows the repo on GitHub Packages).

Pure transform function, covered by a `node --test` spec
(`devops/prepare-fork-publish.spec.mjs`), matching the existing devops test pattern.
Supports `--dry-run` for local inspection.

### 2. Workflow — `.github/workflows/publish-fork.yaml`

- Triggers: `push` to `command-center`, plus `workflow_dispatch`.
- Gate: `github.repository == 'DavidRoyBlue/likec4'` so it never runs upstream or in
  other forks.
- Permissions: `contents: read`, `packages: write` — publishing uses the built-in
  `GITHUB_TOKEN`, no PAT needed.
- Steps: checkout → existing bootstrap composite action → `pnpm ci:build` →
  `node devops/prepare-fork-publish.mjs` → append the `npm.pkg.github.com` auth line to
  `~/.npmrc` and `pnpm publish -r --no-git-checks`.

### 3. Consumer docs — `docs/fork-publishing.md`

pnpm setup for CommandCenterApp:

- `.npmrc` maps the `@davidroyblue` scope to `npm.pkg.github.com` with a
  `read:packages` PAT (GitHub's npm registry requires auth even for public packages).
- npm aliases keep real import names:
  `"likec4": "npm:@davidroyblue/likec4@^1.59.2-cc.0"`,
  `"@likec4/diagram": "npm:@davidroyblue/diagram@^1.59.2-cc.0"`, etc.
- Note: a `^1.59.2-cc.0` range only matches prereleases of that exact base version;
  when the fork rebases onto a new upstream release, bump the range.

## Rollout

1. This work lands via draft PR to fork `main`.
2. After merge, fast-forward `command-center` to `main`
   (`git push origin main:command-center`).
3. The workflow fires and publishes the first `-cc.N` set; verify packages appear under
   the `DavidRoyBlue` account.

## Error handling

- Duplicate versions cannot occur (run number is monotonic).
- The repo gate prevents accidental publishes from upstream or other forks.
- Per-package publish failures surface in the Actions log; the job fails loudly.

## Testing

- Unit spec for the transform (`node --test devops/prepare-fork-publish.spec.mjs`).
- Local `--dry-run` of the script against the real workspace.
- First real publish validated via `workflow_dispatch` + install check.
