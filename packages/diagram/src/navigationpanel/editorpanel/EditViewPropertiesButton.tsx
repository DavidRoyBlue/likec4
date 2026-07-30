import { flattenMarkdownOrString } from '@likec4/core'
import type { ViewChange } from '@likec4/core/types'
import { Button, Popover, PopoverDropdown, PopoverTarget, Stack, Textarea, TextInput } from '@mantine/core'
import { IconPencil } from '@tabler/icons-react'
import { useState } from 'react'
import type { DiagramContext } from '../../hooks/useDiagram'
import { useDiagram, useDiagramContext } from '../../hooks/useDiagram'
import { PanelActionIcon } from '../_common'
import { Tooltip } from './_common'

const selector = (state: DiagramContext) => ({
  title: state.view.title,
  description: state.view.description,
})

export function buildViewPropertyChange(input: {
  title: string
  description: string
  originalTitle: string | null
  originalDescription: string | null
}): ViewChange.ChangeProperty | null {
  const change: ViewChange.ChangeProperty = { op: 'change-property' }
  if (input.title !== (input.originalTitle ?? '')) {
    change.title = input.title
  }
  if (input.description !== (input.originalDescription ?? '')) {
    change.description = { md: input.description }
  }
  return change.title !== undefined || change.description !== undefined ? change : null
}

export const EditViewPropertiesButton = () => {
  const diagram = useDiagram()
  const { title: viewTitle, description: viewDescription } = useDiagramContext(selector)
  const [opened, setOpened] = useState(false)
  const [title, setTitle] = useState('')
  const [description, setDescription] = useState('')

  const open = () => {
    setTitle(viewTitle ?? '')
    setDescription(flattenMarkdownOrString(viewDescription) ?? '')
    setOpened(true)
  }

  const save = () => {
    const change = buildViewPropertyChange({
      title,
      description,
      originalTitle: viewTitle,
      originalDescription: flattenMarkdownOrString(viewDescription) ?? null,
    })
    if (change) {
      diagram.triggerChange(change)
    }
    setOpened(false)
  }

  return (
    <Popover
      opened={opened}
      onDismiss={() => setOpened(false)}
      position="bottom-start"
      radius="xs"
      shadow="lg"
      clickOutsideEvents={[
        'pointerdown',
      ]}>
      <PopoverTarget>
        <Tooltip label="Edit view properties">
          <PanelActionIcon onClick={open}>
            <IconPencil />
          </PanelActionIcon>
        </Tooltip>
      </PopoverTarget>
      <PopoverDropdown className="likec4-top-left-panel" p={8} pt={6}>
        <Stack gap="xs" w={320}>
          <TextInput
            label="Title"
            size="xs"
            value={title}
            onChange={e => setTitle(e.currentTarget.value)}
          />
          <Textarea
            label="Description"
            description="Markdown"
            size="xs"
            autosize
            minRows={3}
            maxRows={10}
            value={description}
            onChange={e => setDescription(e.currentTarget.value)}
            onKeyDown={e => {
              if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) save()
            }}
          />
          <Button size="xs" onClick={save}>Save</Button>
        </Stack>
      </PopoverDropdown>
    </Popover>
  )
}
