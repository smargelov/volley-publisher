// Shared by the Raycast UI and the detached editor worker,
// so it must stay free of `@raycast/api` imports.
import fs from 'node:fs'
import path from 'node:path'
import { thumbDir, type ThumbnailOverlay } from './core'

export interface EditorRequest {
  videoPath: string
  /** Moment to take preview frames around; null reuses the frame and crop saved earlier. */
  momentSec: number | null
  overlay: ThumbnailOverlay
  /** Raycast deeplink opened when the editor is closed, to bring the user back to the review. */
  returnDeeplink?: string
}

export interface EditorStatus {
  state: 'running' | 'done' | 'cancelled' | 'error'
  /** Texts the thumbnail was (or is being) made with; used to spot outdated graphics. */
  overlay: ThumbnailOverlay
  updatedAt: string
  message?: string
}

function statusPath(videoPath: string): string {
  return path.join(thumbDir(videoPath), 'editor.json')
}

export function writeEditorStatus(videoPath: string, status: Omit<EditorStatus, 'updatedAt'>): void {
  fs.mkdirSync(thumbDir(videoPath), { recursive: true })
  fs.writeFileSync(statusPath(videoPath), JSON.stringify({ ...status, updatedAt: new Date().toISOString() }, null, 2))
}

export function readEditorStatus(videoPath: string): EditorStatus | undefined {
  try {
    return JSON.parse(fs.readFileSync(statusPath(videoPath), 'utf8')) as EditorStatus
  } catch {
    return undefined
  }
}
