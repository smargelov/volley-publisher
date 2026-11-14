import './lib/setup'
import {
  Action,
  ActionPanel,
  Alert,
  Color,
  confirmAlert,
  Icon,
  Keyboard,
  type LaunchProps,
  List,
  showToast,
  Toast,
} from '@raycast/api'
import { usePromise } from '@raycast/utils'
import { useState } from 'react'
import { DetailsForm } from './components/DetailsForm'
import { Review } from './components/Review'
import { setPrivacyStatus, tidyInbox, type ChannelVideo } from './lib/core'
import { maintenanceSummary, runMaintenance } from './lib/maintenance'

const DONE_LIMIT = 15

async function loadVideos() {
  const result = await runMaintenance()
  const summary = maintenanceSummary(result)
  if (summary) await showToast({ style: Toast.Style.Success, title: summary })
  return { videos: result.videos, describedIds: new Set(Object.keys(result.store.videos)) }
}

/** Passed by the deeplink the thumbnail editor opens when it is closed. */
interface LaunchContext {
  videoId?: string
}

export default function Command({ launchContext }: LaunchProps<{ launchContext?: LaunchContext }>) {
  const { data, isLoading, error, revalidate } = usePromise(loadVideos)
  // Coming back from the thumbnail editor lands straight on the review of that video.
  const [reviewId, setReviewId] = useState(launchContext?.videoId)

  const reviewItem = reviewId ? data?.videos.find((item) => item.video.id === reviewId) : undefined
  if (reviewItem) {
    return (
      <Review
        item={reviewItem}
        onSaved={() => {
          setReviewId(undefined)
          revalidate()
        }}
      />
    )
  }

  const waiting = data?.videos.filter((item) => item.raw) ?? []
  const done = (data?.videos.filter((item) => !item.raw) ?? []).slice(0, DONE_LIMIT)

  return (
    <List isLoading={isLoading} searchBarPlaceholder="Filter videos…">
      {error ? (
        <List.EmptyView
          icon={Icon.Warning}
          title="Could not load the channel"
          description={`${error.message}\nIf the token has expired, run "npm run volley -- auth" in the project folder.`}
        />
      ) : (
        <List.EmptyView icon={Icon.Video} title="No videos yet" description="Upload videos in YouTube Studio first." />
      )}
      <List.Section title="Waiting for Details" subtitle={String(waiting.length)}>
        {waiting.map((item) => (
          <VideoItem
            key={item.video.id}
            item={item}
            hasAnswers={data?.describedIds.has(item.video.id) ?? false}
            onChange={revalidate}
          />
        ))}
      </List.Section>
      <List.Section title="On YouTube">
        {done.map((item) => (
          <VideoItem key={item.video.id} item={item} hasAnswers onChange={revalidate} />
        ))}
      </List.Section>
    </List>
  )
}

const PRIVACY_COLORS: Record<string, Color> = {
  public: Color.Green,
  unlisted: Color.Orange,
  private: Color.SecondaryText,
}

function VideoItem({ item, hasAnswers, onChange }: { item: ChannelVideo; hasAnswers: boolean; onChange: () => void }) {
  const { video, localPath, raw } = item
  const accessories: List.Item.Accessory[] = []
  if (!localPath) accessories.push({ icon: Icon.QuestionMark, tooltip: 'Source file is not in inbox or done' })
  if (raw && hasAnswers) accessories.push({ tag: 'details saved' })
  if (video.uploadStatus !== 'processed') accessories.push({ text: 'processing', tooltip: video.uploadStatus })
  accessories.push({ tag: { value: video.privacyStatus, color: PRIVACY_COLORS[video.privacyStatus] } })

  const form = <DetailsForm item={item} onSaved={onChange} />
  const review = <Review item={item} onSaved={onChange} />

  return (
    <List.Item
      icon={raw ? Icon.Circle : Icon.CheckCircle}
      title={raw ? (video.fileName ?? video.title) : video.title}
      subtitle={raw ? undefined : video.publishedAt.slice(0, 10)}
      accessories={accessories}
      actions={
        <ActionPanel>
          {localPath && hasAnswers && <Action.Push title="Review and Save" icon={Icon.Eye} target={review} />}
          {localPath && (
            <Action.Push title={hasAnswers ? 'Edit Details' : 'Fill in Details'} icon={Icon.Pencil} target={form} />
          )}
          {!raw && video.privacyStatus !== 'public' && (
            <Action
              title="Make Public"
              icon={Icon.Globe}
              shortcut={{ modifiers: ['cmd', 'shift'], key: 'p' }}
              onAction={() => makePublic(item, onChange)}
            />
          )}
          <Action.OpenInBrowser title="Open on YouTube" url={`https://youtu.be/${video.id}`} />
          <Action.OpenInBrowser
            title="Open in YouTube Studio"
            url={`https://studio.youtube.com/video/${video.id}/edit`}
            shortcut={Keyboard.Shortcut.Common.Open}
          />
          <Action.CopyToClipboard title="Copy Link" content={`https://youtu.be/${video.id}`} />
          <Action
            title="Refresh"
            icon={Icon.ArrowClockwise}
            shortcut={Keyboard.Shortcut.Common.Refresh}
            onAction={onChange}
          />
          <Action title="Move Finished Sources to Done" icon={Icon.Tray} onAction={() => tidy(onChange)} />
        </ActionPanel>
      }
    />
  )
}

async function makePublic(item: ChannelVideo, onChange: () => void) {
  const confirmed = await confirmAlert({
    title: 'Make this video public?',
    message: `${item.video.title}\n\nSubscribers are notified right away and this cannot be taken back.`,
    primaryAction: { title: 'Make Public', style: Alert.ActionStyle.Default },
  })
  if (!confirmed) return

  const toast = await showToast({ style: Toast.Style.Animated, title: 'Publishing…' })
  try {
    await setPrivacyStatus(item.video.id, 'public')
    toast.style = Toast.Style.Success
    toast.title = 'Video is public'
    onChange()
  } catch (error) {
    toast.style = Toast.Style.Failure
    toast.title = 'Could not publish'
    toast.message = error instanceof Error ? error.message : String(error)
  }
}

async function tidy(onChange: () => void) {
  const toast = await showToast({ style: Toast.Style.Animated, title: 'Moving files…' })
  try {
    const moved = await tidyInbox()
    toast.style = Toast.Style.Success
    toast.title = moved.length > 0 ? `Moved ${moved.length} file(s) to done` : 'Nothing to move'
    onChange()
  } catch (error) {
    toast.style = Toast.Style.Failure
    toast.title = 'Could not move files'
    toast.message = error instanceof Error ? error.message : String(error)
  }
}
