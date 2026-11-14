import fs from 'node:fs'
import { getPreferenceValues, trash } from '@raycast/api'
import {
  adoptAnswers,
  findExpiredSources,
  findLocalFile,
  listChannelVideos,
  loadStore,
  saveStore,
  thumbDir,
  tidyInbox,
  trackPublicVideos,
  type ChannelVideo,
  type Store,
} from './core'

const DEFAULT_RETENTION_DAYS = 3

export interface MaintenanceResult {
  videos: ChannelVideo[]
  store: Store
  /** File names moved from inbox to done. */
  moved: string[]
  /** Source files moved to the Trash. */
  trashed: string[]
}

/**
 * Housekeeping done on every list load and by the background command:
 * links answers to re-uploaded files, moves finished sources to done
 * and trashes sources whose videos have been public long enough.
 */
export async function runMaintenance(): Promise<MaintenanceResult> {
  const prefs = getPreferenceValues<Preferences>()
  const [listed, store] = await Promise.all([listChannelVideos(), loadStore()])
  const channelVideos = listed.map((item) => item.video)

  // A file uploaded again gets a new video id: carry its earlier answers over.
  let storeChanged = adoptAnswers(store, channelVideos)
  storeChanged = trackPublicVideos(store, channelVideos) || storeChanged
  if (storeChanged) await saveStore(store)

  // Sources of videos that are described and fully processed move to done on their own.
  const moved = await tidyInbox(channelVideos)

  let trashed: string[] = []
  if (prefs.autoTrash) {
    const days = Number(prefs.retentionDays)
    const retentionDays = Number.isFinite(days) && days >= 0 ? days : DEFAULT_RETENTION_DAYS
    trashed = findExpiredSources(store, channelVideos, retentionDays)
    if (trashed.length > 0) {
      // Preview frames and the thumbnail are useless without the source, so they go along.
      const leftovers = trashed.map((source) => thumbDir(source)).filter((dir) => fs.existsSync(dir))
      await trash([...trashed, ...leftovers])
    }
  }

  const changedOnDisk = moved.length > 0 || trashed.length > 0
  const videos = changedOnDisk ? listed.map((item) => ({ ...item, localPath: findLocalFile(item.video) })) : listed
  return { videos, store, moved, trashed }
}

/** One-line summary of what maintenance did; undefined when nothing happened. */
export function maintenanceSummary(result: MaintenanceResult): string | undefined {
  const parts: string[] = []
  if (result.moved.length > 0) parts.push(`${result.moved.length} moved to done`)
  if (result.trashed.length > 0) parts.push(`${result.trashed.length} moved to the Trash`)
  return parts.length > 0 ? `Sources: ${parts.join(', ')}` : undefined
}
