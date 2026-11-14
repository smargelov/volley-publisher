import { spawn } from 'node:child_process'
import path from 'node:path'
import { environment } from '@raycast/api'
import { isUploadRunning, readUploadStatus, writeUploadStatus, type UploadRequest } from './upload-status'

const WORKER_SCRIPT = path.join(environment.assetsPath, 'upload-worker.js')

/**
 * Starts (or resumes) the upload of a source file through a detached worker.
 * The worker outlives the Raycast command; its progress is read from the status file.
 */
export function startUpload(request: UploadRequest, totalBytes: number): void {
  if (isUploadRunning(readUploadStatus(request.videoPath))) {
    throw new Error('This file is already being uploaded')
  }

  // Placeholder shown until the worker reports its own progress.
  const placeholder = { state: 'running' as const, privacy: request.privacy, sentBytes: 0, totalBytes }
  writeUploadStatus(request.videoPath, placeholder)

  // process.execPath is the Node runtime Raycast uses for extensions, so no separate Node install is needed.
  const child = spawn(process.execPath, [WORKER_SCRIPT, JSON.stringify(request)], {
    detached: true,
    stdio: 'ignore',
  })
  child.unref()
  if (!child.pid) throw new Error('Failed to start the upload')

  // The worker may already have written its own status; only the placeholder gets the pid added.
  const current = readUploadStatus(request.videoPath)
  if (current?.state === 'running' && !current.pid) {
    writeUploadStatus(request.videoPath, { ...placeholder, pid: child.pid })
  }
}

/** Stops a running upload; it can be resumed later from where it stopped. */
export function cancelUpload(videoPath: string): void {
  const status = readUploadStatus(videoPath)
  if (status?.pid && isUploadRunning(status)) process.kill(status.pid, 'SIGTERM')
}
