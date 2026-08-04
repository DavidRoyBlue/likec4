# Consuming this fork from GitHub Packages

This fork publishes all public LikeC4 packages to GitHub Packages
(`npm.pkg.github.com`) under the `@davidroyblue` scope. Publishing happens
automatically on every push to the `command-center` branch (and manually via the
`publish-fork` workflow dispatch). Source package names are untouched — renaming to
`@davidroyblue/*` happens at publish time in CI (`devops/prepare-fork-publish.mjs`).

Versions are stamped `<base>-cc.<run>` per publish, e.g. `1.59.2-cc.7`. The run number
comes from the workflow run, so every publish gets a unique, sortable version.

## Setup in a consumer app (pnpm)

### 1. Authenticate

GitHub's npm registry requires auth even for public packages. Create a classic PAT with
the `read:packages` scope, then add to the app's `.npmrc` (keep the token out of git —
use an env var):

```ini
@davidroyblue:registry=https://npm.pkg.github.com
//npm.pkg.github.com/:_authToken=${GITHUB_PACKAGES_TOKEN}
```

### 2. Alias the packages

Use npm aliases so application code keeps importing the real package names:

```jsonc
{
  "dependencies": {
    "likec4": "npm:@davidroyblue/likec4@^1.59.2-cc.0",
    "@likec4/core": "npm:@davidroyblue/core@^1.59.2-cc.0",
    "@likec4/diagram": "npm:@davidroyblue/diagram@^1.59.2-cc.0",
  },
}
```

See [Consuming: alias every package, not just the ones you import](#consuming-alias-every-package-not-just-the-ones-you-import)
below — aliasing only the packages the app imports directly is not enough.

The React bindings and the Vite plugin ship inside the `likec4` package — import them
from the `likec4/react` and `likec4/vite-plugin` subpaths (there are no separate
`@likec4/react` / `@likec4/vite-plugin` packages; they are private upstream too).

### 3. Version ranges

A `^1.59.2-cc.0` range matches every `1.59.2-cc.N` publish but **not** `1.59.3-cc.N`:
semver only matches prereleases of the same base version. After rebasing the fork onto a
new upstream release, bump the ranges in the consumer app accordingly. Pin an exact
version (`1.59.2-cc.7`) for full reproducibility.

## Consuming: alias every package, not just the ones you import

`prepare-fork-publish.mjs` rewrites manifests only. Built `dist/` output keeps
real `@likec4/*` specifiers, so a published `@davidroyblue/diagram` still does
`import ... from '@likec4/core'` at runtime. Consumers must therefore alias
**every** `@likec4/*` package in the transitive graph:

    "@likec4/core": "npm:@davidroyblue/core@^1.59.2-cc.0"

Missing one does not fail loudly — upstream packages of the same name exist on
npmjs, so the resolver silently mixes upstream code into a fork install.

## Publishing a new build

```sh
git push origin command-center        # or fast-forward it: git push origin main:command-center
```

Watch the `publish-fork` workflow in the fork's Actions tab; published packages appear
under https://github.com/DavidRoyBlue?tab=packages.

## Local dry run

```sh
node devops/prepare-fork-publish.mjs --scope @davidroyblue --build 0 --dry-run
node --test devops/prepare-fork-publish.spec.mjs
```
