import { Action, ActionPanel, Form, Icon, showToast, Toast, useNavigation } from '@raycast/api'
import { usePromise } from '@raycast/utils'
import { useState } from 'react'
import { formatDuration, loadCropChoice, parseTimecode, type MediaFile, type ThumbnailOverlay } from '../lib/core'
import { startEditor } from '../lib/editor'

interface FormValues {
  moment: string
}

/** Asks for the thumbnail moment and opens the editor in the browser. */
export function ThumbnailForm({
  videoId,
  file,
  overlay,
  onStarted,
}: {
  videoId: string
  file: MediaFile
  overlay: ThumbnailOverlay
  onStarted: () => void
}) {
  const { pop } = useNavigation()
  const { data: savedCrop } = usePromise(loadCropChoice, [file.path])
  const [momentError, setMomentError] = useState<string>()

  async function submit(values: FormValues) {
    const input = values.moment.trim()
    let momentSec: number | null = null
    if (input) {
      momentSec = parseTimecode(input)
      if (momentSec === null || momentSec >= file.durationSec) {
        setMomentError(`Use m:ss inside the video (${formatDuration(file.durationSec)})`)
        return
      }
    } else if (!savedCrop) {
      setMomentError('Enter the moment for the thumbnail')
      return
    }

    try {
      startEditor({ videoPath: file.path, momentSec, overlay }, videoId)
      await showToast({ style: Toast.Style.Success, title: 'Thumbnail editor opened in the browser' })
      onStarted()
      pop()
    } catch (error) {
      await showToast({
        style: Toast.Style.Failure,
        title: 'Could not open the editor',
        message: error instanceof Error ? error.message : String(error),
      })
    }
  }

  return (
    <Form
      navigationTitle="Thumbnail"
      actions={
        <ActionPanel>
          <Action.SubmitForm title="Open Editor" icon={Icon.Image} onSubmit={submit} />
        </ActionPanel>
      }
    >
      <Form.TextField
        id="moment"
        title="Moment"
        placeholder="5:53"
        error={momentError}
        onChange={() => setMomentError(undefined)}
        info={`Time inside the video (m:ss), up to ${formatDuration(file.durationSec)}.`}
      />
      {savedCrop && (
        <Form.Description text="Leave the moment empty to rebuild the thumbnail from the frame picked earlier." />
      )}
    </Form>
  )
}
