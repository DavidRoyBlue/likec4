import k from 'tinyrainbow'
import type { LikeC4VitePluginRpc } from '../protocol'
import type { PluginRPCParams } from '../rpc'

export async function updateView(
  { logger, likec4, appliedChanges }: PluginRPCParams,
  data: Parameters<LikeC4VitePluginRpc['updateView']>[0],
): Promise<Awaited<ReturnType<LikeC4VitePluginRpc['updateView']>>> {
  logger.info([
    k.green('view:onChange'),
    k.dim('project'),
    data.projectId,
    k.dim('view'),
    data.viewId,
    k.dim('change'),
    data.change.op,
  ].join(' '))
  // Record BEFORE applying: see updateModel.ts for why (regeneration race).
  const prev = data.changeId ? appliedChanges.get(data.projectId) : undefined
  if (data.changeId) {
    appliedChanges.set(data.projectId, data.changeId)
  }
  const result = await likec4.editor.applyChange(data)
  if (!result.success) {
    if (data.changeId) {
      prev === undefined ? appliedChanges.delete(data.projectId) : appliedChanges.set(data.projectId, prev)
    }
    logger.error(`Failed to apply view change:\n${result.error}`)
    return { success: false, error: result.error }
  }
  logger.info([
    k.green('view:onChange'),
    '✅',
  ].join(' '))
  return { success: true }
}
