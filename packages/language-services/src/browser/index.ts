import {
  type FileSystemProvider,
  type FileSystemWatcher,
  type LikeC4LanguageServices,
  type LikeC4SharedServices,
  createLanguageServices as createBrowserLanguageServices,
  WithLikeC4ManualLayouts,
} from '@likec4/language-server/browser'
import { configureLogger, getConsoleSink, getTextFormatter, rootLogger } from '@likec4/log'
import { URI } from 'langium'
import { basename } from 'pathe'
import { createFromSources } from '../common/createFromSources'
import { type LikeC4Langium, LikeC4 } from '../common/LikeC4'
import type { FromWorkspaceOptions, InitOptions } from '../common/options'

export type {
  FromWorkspaceOptions,
  InitOptions,
  LikeC4Langium,
  LikeC4LanguageServices,
}

export { LikeC4 }

/**
 * Result of {@link fromHost}. `LikeC4` keeps its `langium` services
 * protected, but a host-driven consumer (e.g. an editor backed by a native
 * filesystem) needs direct access to services that aren't exposed through
 * the `LikeC4` facade — notably `langium.likec4.likec4.ModelChanges` for
 * the edit path — so `fromHost` returns both explicitly instead of only
 * the facade.
 */
export type FromHostResult = {
  likec4: LikeC4
  langium: LikeC4Langium
}

/**
 * Create a LikeC4 instance from a workspace directory
 * @param _workspace - The workspace directory path
 * @param options - Optional configuration options
 * @returns A Promise that resolves to a LikeC4 instance
 */
export async function fromWorkspace(_workspace: string, _options?: FromWorkspaceOptions): Promise<LikeC4> {
  throw new Error(`fromWorkspace is not yet implemented in the browser environment. use fromSources`)
}

/**
 * Create a LikeC4 instance from the current working directory
 * @param options - Optional configuration options
 * @returns A Promise that resolves to a LikeC4 instance
 */
export async function fromWorkdir(_options?: FromWorkspaceOptions): Promise<LikeC4> {
  throw new Error(`fromWorkdir is not yet implemented in the browser environment, use fromSources`)
}

/**
 * Create a LikeC4 instance over a host-provided filesystem — the browser twin
 * of `fromWorkspace`. The host supplies I/O; LikeC4 keeps ownership of
 * workspace initialization order.
 *
 * Returns both the `LikeC4` facade and the raw langium services (see
 * {@link FromHostResult}) because the facade alone doesn't expose everything
 * a host-driven consumer needs (e.g. `ModelChanges` for the edit path).
 *
 * @param options.workspacePath - Filesystem path of the workspace root.
 * @param options.fileSystemProvider - Factory for the host's `FileSystemProvider`.
 * @param options.fileSystemWatcher - Optional factory for a `FileSystemWatcher`;
 *   omit to run without file-change notifications.
 */
export async function fromHost(options: {
  workspacePath: string
  fileSystemProvider: () => FileSystemProvider
  fileSystemWatcher?: (services: LikeC4SharedServices) => FileSystemWatcher
}): Promise<FromHostResult> {
  const langium = createBrowserLanguageServices({
    fileSystemProvider: options.fileSystemProvider,
    ...(options.fileSystemWatcher && { fileSystemWatcher: options.fileSystemWatcher }),
    ...WithLikeC4ManualLayouts,
  })
  const rootUri = URI.file(options.workspacePath).toString()
  const workspace = { name: basename(options.workspacePath), uri: rootUri }
  const manager = langium.shared.workspace.WorkspaceManager
  manager.initialize({ capabilities: {}, processId: null, rootUri, workspaceFolders: [workspace] })
  await manager.initialized({})
  const likec4 = new LikeC4(langium, rootLogger.getChild('lang'))
  return { likec4, langium }
}

/**
 * Create a LikeC4 instance from a record of source files
 *
 * @example
 * ```ts
 * const likec4 = await fromSources({
 *   'likec4.config.json': '...', // optional, stringified LikeC4Config
 *   'model.c4': 'model { ... }',
 *   'path/views.c4': 'views { ... }',
 * })
 * ```
 *
 * @param sources - A record of file paths to source content
 * @returns A Promise that resolves to a LikeC4 instance
 */
export async function fromSources(sources: Record<string, string>): Promise<LikeC4> {
  configureLogger({
    sinks: {
      console: getConsoleSink({
        formatter: getTextFormatter({
          format: ({ level, category, message }) => {
            return `${level} ${category} ${message}`
          },
        }),
      }),
    },
    loggers: [
      {
        category: 'likec4',
        sinks: ['console'],
        lowestLevel: 'debug',
      },
    ],
  })

  const logger = rootLogger.getChild('lang')

  const langium = createBrowserLanguageServices()

  return await createFromSources(langium, logger, sources, {})
}

/**
 * Create a LikeC4 instance from a single source string
 * @param source - The LikeC4 source code

 * @returns A Promise that resolves to a LikeC4 instance
 */
export function fromSource(source: string): Promise<LikeC4> {
  return fromSources({ 'source.c4': source })
}
