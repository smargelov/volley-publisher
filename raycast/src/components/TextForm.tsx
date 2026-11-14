import { Action, ActionPanel, Form, Icon, showToast, Toast, useNavigation } from '@raycast/api'
import { loadStore, saveStore, type VideoPlan } from '../lib/core'

interface FormValues {
  title: string
  stage: string
  notes: string
}

/** Lets the user correct the generated English texts before they go to YouTube. */
export function TextForm({ videoId, plan, onSaved }: { videoId: string; plan: VideoPlan; onSaved: () => void }) {
  const { pop } = useNavigation()

  async function submit(values: FormValues) {
    try {
      const store = await loadStore()
      const answers = store.videos[videoId]
      if (!answers) throw new Error('Details for this video are missing')

      answers.partEn = values.stage.trim()
      answers.notesEn = values.notes.trim()
      // The title is generated from the stage, so it is stored only when the user really changed it.
      const title = values.title.trim()
      answers.titleOverride = title && title !== plan.title ? title : answers.titleOverride
      await saveStore(store)

      await showToast({ style: Toast.Style.Success, title: 'Text updated' })
      onSaved()
      pop()
    } catch (error) {
      await showToast({
        style: Toast.Style.Failure,
        title: 'Could not update the text',
        message: error instanceof Error ? error.message : String(error),
      })
    }
  }

  return (
    <Form
      navigationTitle="English Text"
      actions={
        <ActionPanel>
          <Action.SubmitForm title="Save" icon={Icon.Check} onSubmit={submit} />
        </ActionPanel>
      }
    >
      <Form.TextField id="title" title="Title" defaultValue={plan.title} info="Up to 100 characters." />
      <Form.TextField id="stage" title="Stage or Set" defaultValue={plan.meta.part ?? ''} />
      <Form.TextArea id="notes" title="Notes" defaultValue={plan.meta.notes ?? ''} />
    </Form>
  )
}
