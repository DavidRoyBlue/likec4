/**
 * Prepares workspace packages for publishing a fork to GitHub Packages (npm.pkg.github.com).
 *
 * GitHub Packages requires the npm scope to match the repository owner, so this script
 * rewrites every public package manifest in place (CI working copy only):
 *   - `likec4`     -> `@<owner>/likec4`
 *   - `@likec4/x`  -> `@<owner>/x`
 *   - version      -> `<version>-<tag>.<build>` (e.g. `1.59.2-cc.7`)
 *   - inter-package dependency keys renamed; `workspace:` ranges kept (pnpm resolves
 *     them to the stamped versions on publish), other ranges pinned to stamped versions
 *   - `repository.url` pointed at the fork (GitHub Packages links packages via this field)
 *   - `publishConfig.registry` set to GitHub Packages, `publishConfig.access` removed
 *     (visibility follows the repository)
 *
 * Usage (CI): node devops/prepare-fork-publish.mjs
 *   Reads GITHUB_REPOSITORY and GITHUB_RUN_NUMBER.
 * Usage (local): node devops/prepare-fork-publish.mjs --scope @myowner --build 0 --dry-run
 */
import { readdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const GITHUB_REGISTRY = 'https://npm.pkg.github.com'

/**
 * Expands the `packages:` globs of pnpm-workspace.yaml (supports only the `dir`,
 * `dir/*` and `!dir` forms used in this repository).
 */
export function readWorkspaceDirs(rootDir) {
  const yaml = readFileSync(path.join(rootDir, 'pnpm-workspace.yaml'), 'utf8')
  const entries = []
  let inPackages = false
  for (const line of yaml.split('\n')) {
    if (/^packages:\s*$/.test(line)) {
      inPackages = true
      continue
    }
    if (inPackages) {
      const item = line.match(/^\s+-\s+["']?([^"'#]+?)["']?\s*$/)
      if (item) {
        entries.push(item[1])
        continue
      }
      if (line.trim() !== '') break
    }
  }
  const excluded = new Set(
    entries.filter(e => e.startsWith('!')).map(e => e.slice(1).replace(/\/$/, '')),
  )
  const dirs = []
  for (const entry of entries.filter(e => !e.startsWith('!'))) {
    if (entry.endsWith('/*')) {
      const parent = entry.slice(0, -2)
      for (const child of readdirSync(path.join(rootDir, parent), { withFileTypes: true })) {
        if (child.isDirectory()) dirs.push(path.join(parent, child.name))
      }
    } else {
      dirs.push(entry.replace(/\/$/, ''))
    }
  }
  return dirs.filter(dir => !excluded.has(dir))
}

/**
 * Reads all non-private workspace package manifests.
 * @returns {Array<{ dir: string, manifestPath: string, pkg: any }>}
 */
export function discoverPublicPackages(rootDir) {
  const found = []
  for (const dir of readWorkspaceDirs(rootDir)) {
    const manifestPath = path.join(rootDir, dir, 'package.json')
    let pkg
    try {
      pkg = JSON.parse(readFileSync(manifestPath, 'utf8'))
    } catch {
      continue
    }
    if (pkg.private || !pkg.name || !pkg.version) continue
    found.push({ dir, manifestPath, pkg })
  }
  return found
}

/**
 * Computes the rename and version maps for a set of public packages.
 * @returns {{ renames: Map<string, string>, versions: Map<string, string> }}
 */
export function buildRenameContext(pkgs, { scope, tag, build }) {
  const renames = new Map()
  const versions = new Map()
  for (const { name, version } of pkgs) {
    const bare = name.startsWith('@') ? name.split('/')[1] : name
    renames.set(name, `${scope}/${bare}`)
    versions.set(name, `${version}-${tag}.${build}`)
  }
  return { renames, versions }
}

/**
 * Returns the transformed manifest (does not mutate the input).
 */
export function transformManifest(pkg, { renames, versions, repositoryUrl }) {
  const next = structuredClone(pkg)
  next.name = renames.get(pkg.name)
  next.version = versions.get(pkg.name)
  for (const field of ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies']) {
    const deps = next[field]
    if (!deps) continue
    for (const [name, range] of Object.entries(deps)) {
      if (!renames.has(name)) continue
      delete deps[name]
      deps[renames.get(name)] = range.startsWith('workspace:') ? range : versions.get(name)
    }
  }
  next.repository = { ...(typeof next.repository === 'object' ? next.repository : {}), type: 'git', url: repositoryUrl }
  next.publishConfig = { ...next.publishConfig, registry: GITHUB_REGISTRY }
  delete next.publishConfig.access
  return next
}

function parseArgs(argv) {
  const args = { dryRun: false }
  for (let i = 0; i < argv.length; i++) {
    switch (argv[i]) {
      case '--scope':
        args.scope = argv[++i]
        break
      case '--tag':
        args.tag = argv[++i]
        break
      case '--build':
        args.build = argv[++i]
        break
      case '--repository':
        args.repository = argv[++i]
        break
      case '--dry-run':
        args.dryRun = true
        break
      default:
        throw new Error(`Unknown argument: ${argv[i]}`)
    }
  }
  return args
}

export function main(rootDir, argv) {
  const args = parseArgs(argv)
  const ghRepo = process.env.GITHUB_REPOSITORY
  const owner = ghRepo?.split('/')[0]?.toLowerCase()
  const scope = args.scope ?? (owner ? `@${owner}` : null)
  if (!scope?.startsWith('@')) {
    throw new Error('Cannot determine scope: pass --scope @owner or set GITHUB_REPOSITORY')
  }
  const build = args.build ?? process.env.GITHUB_RUN_NUMBER
  if (!build) {
    throw new Error('Cannot determine build number: pass --build N or set GITHUB_RUN_NUMBER')
  }
  const tag = args.tag ?? 'cc'
  const repositoryUrl = args.repository ?? `git+https://github.com/${ghRepo}.git`

  const packages = discoverPublicPackages(rootDir)
  if (packages.length === 0) throw new Error('No public workspace packages found')
  const ctx = { ...buildRenameContext(packages.map(p => p.pkg), { scope, tag, build }), repositoryUrl }

  for (const { manifestPath, pkg } of packages) {
    const next = transformManifest(pkg, ctx)
    console.log(`${pkg.name}@${pkg.version} -> ${next.name}@${next.version}`)
    if (!args.dryRun) {
      writeFileSync(manifestPath, JSON.stringify(next, null, 2) + '\n')
    }
  }
  if (args.dryRun) console.log('(dry run, nothing written)')
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'), process.argv.slice(2))
}
