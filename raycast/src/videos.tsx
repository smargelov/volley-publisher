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
import { useEffect, useRef, useState } from 'react'
import { DetailsForm } from './components/DetailsForm'
import { Review } from './components/Review'
import {
  listPendingUploads,
  setPrivacyStatus,
  tidyInbox,
  type ChannelVideo,
  type PrivacyStatus,
  type SourceFile,
} from './lib/core'
import { maintenanceSummary, runMaintenance } from './lib/maintenance'
import { isUploadRunning, readUploadStatus, type UploadStatus } from './lib/upload-status'
import { cancelUpload, startUpload } from './lib/uploader'

const DONE_LIMIT = 15
/** How often upload progress is re-read from the status files while something is uploading. */
const UPLOAD_POLL_MS = 2000
/** A finished upload can take a while to show up in the channel list; the file is not offered again meanwhile. */
const UPLOADED_GRACE_MS = 30 * 60_000
const GIB = 1024 ** 3

async function loadVideos() {
  const result = await runMaintenance()
  const summary = maintenanceSummary(result)
  if (summary) await showToast({ style: Toast.Style.Success, title: summary })
  const pending = await listPendingUploads(result.videos.map((item) => item.video))
  return { videos: result.videos, pending, describedIds: new Set(Object.keys(result.store.videos)) }
}

/** Passed by the deeplink the thumbnail editor opens when it is closed. */
interface LaunchContext {
  videoId?: string
}

export default function Command({ launchContext }: LaunchProps<{ launchContext?: LaunchContext }>) {
  const { data, isLoading, error, revalidate } = usePromise(loadVideos)
  // Coming back from the thumbnail editor lands straight on the review of that video.
  const [reviewId, setReviewId] = useState(launchContext?.videoId)

  const pending = data?.pending ?? []
  const statuses = new Map(pending.map((file) => [file.path, readUploadStatus(file.path)]))
  const uploadingPaths = pending.filter((file) => isUploadRunning(statuses.get(file.path))).map((file) => file.path)
  const uploading = uploadingPaths.join('\n')

  // While something is uploading, progress is re-read from the status files.
  const [, setTick] = useState(0)
  useEffect(() => {
    if (!uploading) return
    const timer = setInterval(() => setTick((tick) => tick + 1), UPLOAD_POLL_MS)
    return () => clearInterval(timer)
  }, [uploading])

  // An upload that has just finished turns into a channel video: reload the list.
  const wasUploading = useRef('')
  useEffect(() => {
    const finished = wasUploading.current.split('\n').some((path) => path && !uploadingPaths.includes(path))
    wasUploading.current = uploading
    if (finished) revalidate()
  }, [uploading])

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
        <List.EmptyView
          icon={Icon.Video}
          title="No videos yet"
          description="Put source videos into the inbox folder to upload them from here."
        />
      )}
      <List.Section title="Waiting for Upload" subtitle={String(pending.length)}>
        {pending.map((file) => (
          <UploadItem key={file.path} file={file} status={statuses.get(file.path)} onChange={revalidate} />
        ))}
      </List.Section>
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

const UPLOAD_PRIVACY_TITLES: Record<PrivacyStatus, string> = {
  private: 'Private — Only You',
  unlisted: 'Unlisted — Anyone with the Link',
  public: 'Public — Subscribers Are Notified',
}

function percent(status: UploadStatus): string {
  return status.totalBytes > 0 ? `${Math.floor((status.sentBytes / status.totalBytes) * 100)}%` : '0%'
}

/** A source file in the inbox that is not on the channel yet. */
function UploadItem({ file, status, onChange }: { file: SourceFile; status?: UploadStatus; onChange: () => void }) {
  const running = isUploadRunning(status)
  // The worker is gone but never reported an outcome: it was killed or the Mac went to sleep.
  const interrupted = status?.state === 'running' && !running
  const justUploaded = status?.state === 'done' && Date.now() - new Date(status.updatedAt).getTime() < UPLOADED_GRACE_MS
  const resumable = interrupted || status?.state === 'cancelled' || status?.state === 'error'

  const accessories: List.Item.Accessory[] = [{ text: `${(file.sizeBytes / GIB).toFixed(2)} GB` }]
  if (running && status) accessories.push({ tag: { value: `uploading ${percent(status)}`, color: Color.Blue } })
  else if (justUploaded)
    accessories.push({ tag: { value: 'uploaded', color: Color.Green }, tooltip: 'Appears below shortly' })
  else if (status?.state === 'error')
    accessories.push({ tag: { value: 'failed', color: Color.Red }, tooltip: status.message })
  else if (interrupted || status?.state === 'cancelled')
    accessories.push({ tag: { value: 'paused', color: Color.Orange } })

  function upload(privacy: PrivacyStatus) {
    try {
      startUpload({ videoPath: file.path, privacy }, file.sizeBytes)
      void showToast({ style: Toast.Style.Success, title: 'Upload started', message: 'It continues in the background' })
      onChange()
    } catch (error) {
      void showToast({
        style: Toast.Style.Failure,
        title: 'Could not start the upload',
        message: error instanceof Error ? error.message : String(error),
      })
    }
  }

  return (
    <List.Item
      icon={running ? Icon.Upload : Icon.Document}
      title={file.fileName}
      accessories={accessories}
      actions={
        <ActionPanel>
          {running && (
            <Action
              title="Pause Upload"
              icon={Icon.Pause}
              onAction={() => {
                cancelUpload(file.path)
                onChange()
              }}
            />
          )}
          {!running && !justUploaded && resumable && status && (
            // The visibility was fixed when the upload started, so resuming keeps it.
            <Action title="Resume Upload" icon={Icon.Upload} onAction={() => upload(status.privacy)} />
          )}
          {!running && !justUploaded && !resumable && (
            <ActionPanel.Submenu title="Upload to YouTube" icon={Icon.Upload}>
              {(Object.keys(UPLOAD_PRIVACY_TITLES) as PrivacyStatus[]).map((privacy) => (
                <Action key={privacy} title={UPLOAD_PRIVACY_TITLES[privacy]} onAction={() => upload(privacy)} />
              ))}
            </ActionPanel.Submenu>
          )}
          <Action.ShowInFinder path={file.path} />
          <Action
            title="Refresh"
            icon={Icon.ArrowClockwise}
            shortcut={Keyboard.Shortcut.Common.Refresh}
            onAction={onChange}
          />
        </ActionPanel>
      }
    />
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
