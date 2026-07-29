import { LikeC4Model } from '@likec4/core/model'
import JSON5 from 'json5'
import { logGenerating } from '../logger'
import { type ProjectVirtualModule, generateCombinedProjects, generateMatches } from './_shared'

const projectModelCode = (model: LikeC4Model.Layouted, appliedChangeId: string | null) => `
import { createHooksForModel, atom } from 'likec4/vite-plugin/internal'

export let $likec4data = atom(${JSON5.stringify(model.$data)})
export let $appliedChangeId = atom(${JSON5.stringify(appliedChangeId)})

export let {
  updateModel,
  $likec4model,
  useLikeC4Model,
  useLikeC4Views,
  useLikeC4View
} = createHooksForModel($likec4data)

if (import.meta.hot) {
  import.meta.hot.accept(md => {
    if (!import.meta.hot.data.$update) {
      import.meta.hot.data.$update = updateModel
    }
    if (!import.meta.hot.data.$ackUpdate) {
      import.meta.hot.data.$ackUpdate = (v) => $appliedChangeId.set(v)
    }
    const update = md.$likec4data?.get()
    if (update) {
      import.meta.hot.data.$update(update)
      import.meta.hot.data.$ackUpdate(md.$appliedChangeId?.get() ?? null)
    } else {
      import.meta.hot.invalidate()
    }
  })
}
`

export const projectModelModule: ProjectVirtualModule = {
  ...generateMatches('model'),
  async load({ likec4, project, ...opts }) {
    logGenerating('model', project.id)
    const model = await likec4.layoutedModel(project.id)
    return {
      code: projectModelCode(model, opts.appliedChanges.get(project.id) ?? null),
      moduleType: 'js',
    }
  },
}

export const modelModule = generateCombinedProjects('model', 'loadModel')
