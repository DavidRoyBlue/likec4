import assert from 'node:assert/strict'
import path from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import {
  buildRenameContext,
  discoverPublicPackages,
  readWorkspaceDirs,
  transformManifest,
} from './prepare-fork-publish.mjs'

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

const fixtures = [
  { name: 'likec4', version: '1.59.2' },
  { name: '@likec4/core', version: '1.59.2' },
  { name: '@likec4/icons', version: '1.46.4' },
]
const ctx = () => ({
  ...buildRenameContext(fixtures, { scope: '@davidroyblue', tag: 'cc', build: '7' }),
  repositoryUrl: 'git+https://github.com/DavidRoyBlue/likec4.git',
})

test('renames unscoped and scoped packages, keeping per-package base versions', () => {
  const { renames, versions } = ctx()
  assert.equal(renames.get('likec4'), '@davidroyblue/likec4')
  assert.equal(renames.get('@likec4/core'), '@davidroyblue/core')
  assert.equal(versions.get('likec4'), '1.59.2-cc.7')
  assert.equal(versions.get('@likec4/icons'), '1.46.4-cc.7')
})

test('transforms manifest: name, version, deps, repository, publishConfig', () => {
  const pkg = {
    name: 'likec4',
    version: '1.59.2',
    repository: { type: 'git', url: 'git+https://github.com/likec4/likec4.git', directory: 'packages/likec4' },
    publishConfig: { registry: 'https://registry.npmjs.org', access: 'public', types: './lib/index.d.ts' },
    dependencies: {
      '@likec4/core': 'workspace:*',
      '@likec4/icons': '1.46.4',
      'react': '^19.0.0',
    },
    devDependencies: { '@likec4/core': 'workspace:*' },
  }
  const next = transformManifest(pkg, ctx())

  assert.equal(next.name, '@davidroyblue/likec4')
  assert.equal(next.version, '1.59.2-cc.7')
  // workspace ranges kept (pnpm resolves them at publish), plain ranges pinned
  assert.equal(next.dependencies['@davidroyblue/core'], 'workspace:*')
  assert.equal(next.dependencies['@davidroyblue/icons'], '1.46.4-cc.7')
  assert.equal(next.dependencies['react'], '^19.0.0')
  assert.equal('@likec4/core' in next.dependencies, false)
  assert.equal(next.devDependencies['@davidroyblue/core'], 'workspace:*')
  assert.equal(next.repository.url, 'git+https://github.com/DavidRoyBlue/likec4.git')
  assert.equal(next.repository.directory, 'packages/likec4')
  assert.equal(next.publishConfig.registry, 'https://npm.pkg.github.com')
  assert.equal(next.publishConfig.access, undefined)
  assert.equal(next.publishConfig.types, './lib/index.d.ts')
  // input untouched
  assert.equal(pkg.name, 'likec4')
  assert.equal(pkg.dependencies['@likec4/core'], 'workspace:*')
})

test('reads workspace dirs from pnpm-workspace.yaml with exclusions applied', () => {
  const dirs = readWorkspaceDirs(rootDir)
  assert.ok(dirs.includes(path.join('packages', 'core')))
  assert.ok(dirs.includes(path.join('styled-system', 'styles')))
  assert.ok(!dirs.includes(path.join('packages', 'create-likec4')))
})

test('discovers the real public packages of this repository', () => {
  const names = discoverPublicPackages(rootDir).map(p => p.pkg.name)
  assert.ok(names.includes('likec4'))
  assert.ok(names.includes('@likec4/core'))
  assert.ok(names.includes('@likec4/styles'))
  // private packages are excluded
  assert.ok(!names.includes('@likec4/spa'))
  assert.ok(!names.includes('@likec4/react'))
})
