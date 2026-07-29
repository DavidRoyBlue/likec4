import type * as scalar from './scalar'

export namespace ModelChange {
  /**
   * Change properties of a model element (identified by FQN).
   * Grammar guarantees title/description/technology live only at the
   * declaration site (extend carries only tags/links/metadata).
   */
  export interface ChangeElementProperty {
    op: 'change-element-property'
    target: scalar.Fqn
    title?: string
    /**
     * Plain string → single-quoted literal; { md } → triple-quoted markdown block.
     * ops.props.descriptionProperty() accepts both (generators/.../properties.ts:74).
     */
    description?: string | scalar.MarkdownOrString
    technology?: string
    tag?: {
      add?: scalar.Tag | scalar.Tag[]
      remove?: scalar.Tag | scalar.Tag[]
    }
  }
}

export type ModelChange = ModelChange.ChangeElementProperty
