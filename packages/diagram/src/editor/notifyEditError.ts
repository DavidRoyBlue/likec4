import { notifications } from '@mantine/notifications'

export function notifyEditError({ op, error }: { op: string; error: string }) {
  notifications.show({
    color: 'red',
    title: `Edit failed (${op})`,
    message: error,
    withCloseButton: true,
    autoClose: 8000,
  })
}

export function notifyEditWarning(message: string) {
  notifications.show({
    color: 'yellow',
    title: 'Applied with warning',
    message,
    withCloseButton: true,
    autoClose: 8000,
  })
}
