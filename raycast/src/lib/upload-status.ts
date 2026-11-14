// Shared by the Raycast UI and the detached upload worker,
// so it must stay free of `@raycast/api` imports.
import fs from 'node:fs'
import path from 'node:path'
import { thumbDir, type PrivacyStatus } from './core'

export interface UploadRequest {
  videoPath: string
  privacy: PrivacyStatus
}

export interface UploadStatus {
  state: 'running' | 'done' | 'error' | 'cancelled'
  privacy: PrivacyStatus
  sentBytes: number
  totalBytes: number
  /** Process id of the worker while it is running. */
  pid?: number
  /** Set once YouTube has accepted the whole file. */
  videoId?: string
  message?: string
  updatedAt: string
}

function statusPath(videoPath: string): string {
  return path.join(thumbDir(videoPath), 'upload.json')
}

export function writeUploadStatus(videoPath: string, status: Omit<UploadStatus, 'updatedAt'>): void {
  fs.mkdirSync(thumbDir(videoPath), { recursive: true })
  fs.writeFileSync(statusPath(videoPath), JSON.stringify({ ...status, updatedAt: new Date().toISOString() }, null, 2))
}

export function readUploadStatus(videoPath: string): UploadStatus | undefined {
  try {
    return JSON.parse(fs.readFileSync(statusPath(videoPath), 'utf8')) as UploadStatus
  } catch {
    return undefined
  }
}

/** True while the worker that wrote the status is still alive. */
export function isUploadRunning(status: UploadStatus | undefined): boolean {
  if (status?.state !== 'running' || !status.pid) return false
  try {
    // Signal 0 only checks that the process exists.
    process.kill(status.pid, 0)
    return true
  } catch {
    return false
  }
}
