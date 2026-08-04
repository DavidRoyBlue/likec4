import { isLikeC4Config } from '@likec4/config'
import { URI } from 'langium'
import { basename } from 'pathe'
import type { LikeC4SharedServices } from '../module'
import { isManualLayoutFile } from './LikeC4ManualLayouts'
import { hasLikeC4Ext } from './utils'

export type FileSystemEventKind = 'add' | 'change' | 'unlink'

/**
 * Routes one filesystem event to the right service. Extracted so host-driven
 * watchers (a Tauri webview, a VSCode extension) reuse it instead of each
 * re-implementing which file means what.
 */
export async function handleFileSystemEvent(
  services: LikeC4SharedServices,
  event: { kind: FileSystemEventKind; path: string },
): Promise<void> {
  const workspace = services.workspace
  const filename = basename(event.path)
  const uri = URI.file(event.path)
  const removed = event.kind === 'unlink'

  if (isLikeC4Config(filename)) {
    workspace.ManualLayouts.clearCaches()
    await (removed ? workspace.ProjectsManager.reloadProjects() : workspace.ProjectsManager.registerConfigFile(uri))
    return
  }
  if (isManualLayoutFile(filename)) {
    await workspace.ManualLayouts.handleFileSystemUpdate(removed ? { delete: uri } : { update: uri })
    return
  }
  if (hasLikeC4Ext(filename)) {
    await workspace.DocumentBuilder.update(removed ? [] : [uri], removed ? [uri] : [])
  }
}
