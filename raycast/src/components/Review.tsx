import fs from 'node:fs'
import {
  Action,
  ActionPanel,
  Alert,
  Color,
  confirmAlert,
  Detail,
  getPreferenceValues,
  Icon,
  showToast,
  Toast,
  useNavigation,
  Keyboard,
} from '@raycast/api'
import { usePromise } from '@raycast/utils'
import { useEffect } from 'react'
import {
  applyPlan,
  buildPlan,
  loadStore,
  probeFile,
  thumbnailPath,
  type ChannelVideo,
  type PrivacyStatus,
} from '../lib/core'
import { readEditorStatus } from '../lib/editor-status'
import { DetailsForm } from './DetailsForm'
import { TextForm } from './TextForm'
import { ThumbnailForm } from './ThumbnailForm'

/** How often the editor status is re-read while the editor is open in the browser. */
const EDITOR_POLL_MS = 2000

const PRIVACY_TITLES: Record<PrivacyStatus, string> = {
  unlisted: 'Unlisted (by link)',
  public: 'Public',
  private: 'Private',
}

async function loadReview(item: ChannelVideo) {
  if (!item.localPath) throw new Error('Source file is not in inbox or done')
  const [store, file] = await Promise.all([loadStore(), probeFile(item.localPath)])
  const plan = buildPlan(store, file, item.video.id)

  const thumbnail = thumbnailPath(file.path)
  const thumbnailMtime = fs.existsSync(thumbnail) ? fs.statSync(thumbnail).mtimeMs : undefined
  return { file, plan, thumbnail, thumbnailMtime, editor: readEditorStatus(file.path) }
}

/** Shows what will be written to YouTube and writes it. */
export function Review({ item, onSaved }: { item: ChannelVideo; onSaved: () => void }) {
  const { pop } = useNavigation()
  const prefs = getPreferenceValues<Preferences>()
  const { data, isLoading, error, revalidate } = usePromise(loadReview, [item])

  // While the editor is open in the browser, keep checking whether the thumbnail is ready.
  const editorRunning = data?.editor?.state === 'running'
  useEffect(() => {
    if (!editorRunning) return
    const timer = setInterval(revalidate, EDITOR_POLL_MS)
    return () => clearInterval(timer)
  }, [editorRunning, revalidate])

  if (error) return <Detail markdown={`# Could not load the video\n\n${error.message}`} />
  if (!data) return <Detail isLoading={isLoading} />

  const { file, plan, thumbnail, thumbnailMtime, editor } = data
  if (!plan) {
    return (
      <Detail
        markdown="# No details yet\n\nFill in the details for this video first."
        actions={
          <ActionPanel>
            <Action.Push
              title="Fill in Details"
              icon={Icon.Pencil}
              target={<DetailsForm item={item} onSaved={onSaved} />}
            />
          </ActionPanel>
        }
      />
    )
  }

  const hasThumbnail = thumbnailMtime !== undefined
  // A thumbnail made with other texts than the current ones needs to be rebuilt.
  const thumbnailOutdated =
    hasThumbnail && editor?.state === 'done' && JSON.stringify(editor.overlay) !== JSON.stringify(plan.overlay)

  let thumbnailStatus = { text: 'Not made', color: Color.SecondaryText }
  if (editorRunning) thumbnailStatus = { text: 'Editor is open in the browser', color: Color.Blue }
  else if (editor?.state === 'error') thumbnailStatus = { text: editor.message ?? 'Editor failed', color: Color.Red }
  else if (thumbnailOutdated) thumbnailStatus = { text: 'Texts changed, rebuild it', color: Color.Orange }
  else if (hasThumbnail) thumbnailStatus = { text: 'Ready', color: Color.Green }

  const markdown = [
    // The modification time busts Raycast's image cache when the thumbnail is rebuilt.
    hasThumbnail ? `![Thumbnail](${encodeURI(thumbnail)}?t=${thumbnailMtime})` : '_No thumbnail yet._',
    `## ${plan.title}`,
    '```',
    plan.description,
    '```',
  ].join('\n\n')

  async function save(privacy: PrivacyStatus) {
    if (!plan) return
    if (editorRunning) {
      const proceed = await confirmAlert({
        title: 'The thumbnail editor is still open',
        message: hasThumbnail
          ? 'Save now with the previous thumbnail?'
          : 'Save now without a thumbnail? You can add it later.',
        primaryAction: { title: 'Save Anyway' },
      })
      if (!proceed) return
    }
    if (privacy === 'public') {
      const proceed = await confirmAlert({
        title: 'Make this video public?',
        message: 'Subscribers are notified right away and this cannot be taken back.',
        primaryAction: { title: 'Save and Make Public', style: Alert.ActionStyle.Default },
      })
      if (!proceed) return
    }

    const toast = await showToast({ style: Toast.Style.Animated, title: 'Saving to YouTube…' })
    try {
      const warnings = await applyPlan(item.video, file, plan, privacy, hasThumbnail ? thumbnail : undefined)
      if (warnings.length > 0) {
        toast.style = Toast.Style.Failure
        toast.title = 'Saved with problems'
        toast.message = warnings.join(' ')
        // The toast shrinks to its title once the view closes, so the reasons get their own dialog.
        await confirmAlert({
          title: 'Saved with problems',
          message: warnings.join('\n\n'),
          primaryAction: { title: 'OK' },
        })
      } else {
        toast.style = Toast.Style.Success
        toast.title = `Saved: ${PRIVACY_TITLES[privacy].toLowerCase()}`
      }
      onSaved()
      pop()
    } catch (error) {
      toast.style = Toast.Style.Failure
      toast.title = 'Could not save to YouTube'
      toast.message = error instanceof Error ? error.message : String(error)
    }
  }

  const defaultPrivacy = prefs.defaultPrivacy as PrivacyStatus
  const otherPrivacies = (Object.keys(PRIVACY_TITLES) as PrivacyStatus[]).filter((p) => p !== defaultPrivacy)

  return (
    <Detail
      isLoading={isLoading}
      navigationTitle={file.fileName}
      markdown={markdown}
      metadata={
        <Detail.Metadata>
          <Detail.Metadata.TagList title="Thumbnail">
            <Detail.Metadata.TagList.Item text={thumbnailStatus.text} color={thumbnailStatus.color} />
          </Detail.Metadata.TagList>
          <Detail.Metadata.Label title="Playlist" text={plan.session.playlistTitle ?? 'None'} />
          <Detail.Metadata.Label title="Current Visibility" text={item.video.privacyStatus} />
          <Detail.Metadata.Separator />
          <Detail.Metadata.Label title="Games" text={`${plan.event.nameRu} (${plan.event.nameEn})`} />
          <Detail.Metadata.Label title="Venue" text={`${plan.venue.name}, ${plan.venue.city}`} />
          <Detail.Metadata.Label title="Recorded" text={`${file.localDate} ${file.localTime}`} />
          <Detail.Metadata.TagList title="Tags">
            {plan.tags.map((tag) => (
              <Detail.Metadata.TagList.Item key={tag} text={tag} />
            ))}
          </Detail.Metadata.TagList>
        </Detail.Metadata>
      }
      actions={
        <ActionPanel>
          <Action
            title={`Save to YouTube: ${PRIVACY_TITLES[defaultPrivacy]}`}
            icon={Icon.Upload}
            onAction={() => save(defaultPrivacy)}
          />
          {otherPrivacies.map((privacy) => (
            <Action
              key={privacy}
              title={`Save to YouTube: ${PRIVACY_TITLES[privacy]}`}
              icon={privacy === 'public' ? Icon.Globe : Icon.Lock}
              onAction={() => save(privacy)}
            />
          ))}
          <ActionPanel.Section>
            <Action.Push
              title={hasThumbnail ? 'Redo Thumbnail' : 'Make Thumbnail'}
              icon={Icon.Image}
              shortcut={{ modifiers: ['cmd'], key: 't' }}
              target={
                <ThumbnailForm videoId={item.video.id} file={file} overlay={plan.overlay} onStarted={revalidate} />
              }
            />
            <Action.Push
              title="Edit English Text"
              icon={Icon.Text}
              shortcut={Keyboard.Shortcut.Common.Edit}
              target={<TextForm videoId={item.video.id} plan={plan} onSaved={revalidate} />}
            />
            <Action.Push
              title="Edit Details"
              icon={Icon.Pencil}
              shortcut={{ modifiers: ['cmd', 'shift'], key: 'e' }}
              target={<DetailsForm item={item} onSaved={onSaved} />}
            />
          </ActionPanel.Section>
          <ActionPanel.Section>
            {hasThumbnail && <Action.Open title="Open Thumbnail" target={thumbnail} />}
            <Action.OpenInBrowser
              title="Open in YouTube Studio"
              url={`https://studio.youtube.com/video/${item.video.id}/edit`}
            />
            <Action
              title="Refresh"
              icon={Icon.ArrowClockwise}
              shortcut={Keyboard.Shortcut.Common.Refresh}
              onAction={revalidate}
            />
          </ActionPanel.Section>
        </ActionPanel>
      }
    />
  )
}
