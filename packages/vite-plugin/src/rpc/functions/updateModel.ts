import k from 'tinyrainbow'
import type { LikeC4VitePluginRpc } from '../protocol'
import type { PluginRPCParams } from '../rpc'

export async function updateModel(
  params: PluginRPCParams,
  data: Parameters<LikeC4VitePluginRpc['updateModel']>[0],
): Promise<Awaited<ReturnType<LikeC4VitePluginRpc['updateModel']>>> {
  const { logger, likec4, appliedChanges } = params
  logger.info([
    k.green('model:onChange'),
    k.dim('project'),
    data.projectId,
    k.dim('change'),
    data.change.op,
  ].join(' '))
  // Record BEFORE applying: DocumentBuilder.update (inside applyModelChange) is
  // what triggers regeneration of likec4:model/<project>, which READS this map.
  // Setting after the await races the regeneration and can push a stale ack,
  // stalling the client queue on its escape hatch.
  const prev = data.changeId ? appliedChanges.get(data.projectId) : undefined
  if (data.changeId) {
    appliedChanges.set(data.projectId, data.changeId)
  }
  const result = await likec4.editor.applyModelChange({
    change: data.change,
    projectId: data.projectId,
    changeId: data.changeId,
  })
  if (!result.success) {
    if (data.changeId) {
      prev === undefined ? appliedChanges.delete(data.projectId) : appliedChanges.set(data.projectId, prev)
    }
    logger.error(`Failed to apply model change:\n${result.error}`)
    return { success: false, error: result.error }
  }
  logger.info([k.green('model:onChange'), '✅'].join(' '))
  return { success: true, ...(result.warnings && { warnings: result.warnings }) }
}
