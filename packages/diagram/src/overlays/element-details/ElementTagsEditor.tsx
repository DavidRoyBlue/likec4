import type { Fqn, Tag } from '@likec4/core/types'
import {
  ActionIcon,
  Badge,
  Box,
  Combobox,
  ComboboxDropdown,
  ComboboxEmpty,
  ComboboxOption,
  ComboboxOptions,
  ComboboxTarget,
  Flex,
  useCombobox,
} from '@mantine/core'
import { IconPlus, IconX } from '@tabler/icons-react'
import { ElementTag } from '../../base-primitives/element/ElementTags'
import { useEnabledFeatures } from '../../context/DiagramFeatures'
import { useDiagram } from '../../hooks/useDiagram'

export type ElementTagsEditorProps = {
  target: Fqn
  /**
   * Tags currently applied to the element (own + inherited from kind).
   */
  tags: readonly string[]
  /**
   * All tags known to the project's specification.
   */
  specTags: readonly string[]
  /**
   * Called when a tag chip (not the remove button) is clicked, e.g. to open search.
   */
  onTagClick?: (tag: string) => void
}

/**
 * Renders element tags as removable chips, plus an add-combobox listing
 * specification tags not yet applied to the element. Falls back to plain
 * (non-removable) chips when the diagram is read-only.
 */
export function ElementTagsEditor({ target, tags, specTags, onTagClick }: ElementTagsEditorProps) {
  const { enableReadOnly } = useEnabledFeatures()
  const diagram = useDiagram()
  const combobox = useCombobox({
    onDropdownClose: () => combobox.resetSelectedOption(),
  })

  if (enableReadOnly) {
    return (
      <Flex gap={4} flex={1} wrap="wrap">
        {tags.map((tag) => (
          <ElementTag
            key={tag}
            tag={tag}
            cursor={onTagClick ? 'pointer' : 'default'}
            onClick={onTagClick
              ? (e) => {
                e.stopPropagation()
                onTagClick(tag)
              }
              : undefined}
          />
        ))}
        {tags.length === 0 && <Badge radius={'sm'} size="sm" fw={600} color="gray">—</Badge>}
      </Flex>
    )
  }

  const unapplied = specTags.filter((tag) => !tags.includes(tag))

  // `scalar.Tag` is a branded string; the diagram-side model is loaded with an erased
  // Aux at this call site, so tag names surface here as plain strings and are cast at
  // this single boundary before being sent as a ModelChange.
  const removeTag = (tag: string) => {
    diagram.triggerModelChange({
      op: 'change-element-property',
      target,
      tag: { remove: tag as Tag },
    })
  }
  const addTag = (tag: string) => {
    diagram.triggerModelChange({
      op: 'change-element-property',
      target,
      tag: { add: tag as Tag },
    })
  }

  return (
    <Flex gap={4} flex={1} wrap="wrap" align="center">
      {tags.map((tag) => (
        <Box key={tag} style={{ position: 'relative' }}>
          <ElementTag
            tag={tag}
            style={{ paddingRight: 16 }}
            cursor={onTagClick ? 'pointer' : 'default'}
            onClick={onTagClick
              ? (e) => {
                e.stopPropagation()
                onTagClick(tag)
              }
              : undefined}
          />
          <ActionIcon
            size={12}
            radius="xl"
            variant="filled"
            color="gray"
            aria-label={`Remove tag ${tag}`}
            onClick={(e) => {
              e.stopPropagation()
              removeTag(tag)
            }}
            style={{ position: 'absolute', top: -4, right: -4 }}>
            <IconX size={8} />
          </ActionIcon>
        </Box>
      ))}
      {tags.length === 0 && <Badge radius={'sm'} size="sm" fw={600} color="gray">—</Badge>}
      {unapplied.length > 0 && (
        <Combobox
          store={combobox}
          width={180}
          position="bottom-start"
          withinPortal={false}
          onOptionSubmit={(value) => {
            addTag(value)
            combobox.closeDropdown()
          }}>
          <ComboboxTarget>
            <ActionIcon
              size="xs"
              variant="subtle"
              aria-label="Add tag"
              onClick={() => combobox.toggleDropdown()}>
              <IconPlus size={12} />
            </ActionIcon>
          </ComboboxTarget>
          <ComboboxDropdown>
            <ComboboxOptions>
              {unapplied.map((tag) => (
                <ComboboxOption value={tag} key={tag}>
                  {tag}
                </ComboboxOption>
              ))}
              {unapplied.length === 0 && <ComboboxEmpty>No tags left</ComboboxEmpty>}
            </ComboboxOptions>
          </ComboboxDropdown>
        </Combobox>
      )}
    </Flex>
  )
}
