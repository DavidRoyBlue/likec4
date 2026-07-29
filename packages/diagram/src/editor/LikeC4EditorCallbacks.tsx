import type * as t from '@likec4/core/types'

/**
 * Callbacks from LikeC4 Editor.
 */
export interface LikeC4EditorCallbacks {
  /**
   * Apply semantic layout to a view (if AI is available)
   * See vite-plugin settings for more details
   */
  applySemanticLayout?: undefined | ((viewId: t.ViewId) => Promise<void>)

  /**
   * Fetch a view by its ID and layout type.
   *
   * @param viewId - The ID of the view to fetch.
   * @param layout - The layout type to use when fetching the view.
   */
  fetchView(viewId: t.ViewId, layout?: t.LayoutType): t.LayoutedView | Promise<t.LayoutedView>

  /**
   * Callback invoked when the view changes.
   *
   * @param meta - Optional. `meta.changeId` is the ack token the editor waits for:
   * forward it to the server so the resulting model update can be correlated back.
   * Ports that omit it fall back to un-correlated acks.
   */
  handleChange(viewId: t.ViewId, change: t.ViewChange, meta?: { changeId: string }): void | Promise<void>

  /**
   * Callback invoked when an element-scoped model change is requested.
   *
   * @param meta.changeId - The ack token the editor waits for: forward it to the
   * server so the resulting model update can be correlated back.
   * @returns Optionally, warnings surfaced from applying the change.
   */
  handleModelChange?: (
    change: t.ModelChange,
    meta: { changeId: string },
  ) => void | Promise<void | { warnings?: string[] }>
}

export function createLikeC4Editor(callbacks: LikeC4EditorCallbacks): LikeC4EditorCallbacks {
  return callbacks
}
