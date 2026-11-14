import { spawn } from 'node:child_process'
import path from 'node:path'
import { environment } from '@raycast/api'
import { writeEditorStatus, type EditorRequest } from './editor-status'

const WORKER_SCRIPT = path.join(environment.assetsPath, 'editor-worker.js')

/** Deeplink that reopens the videos command on the review of the given video. */
function reviewDeeplink(videoId: string): string {
  const context = encodeURIComponent(JSON.stringify({ videoId }))
  return `raycast://extensions/${environment.ownerOrAuthorName}/${environment.extensionName}/videos?context=${context}`
}

/**
 * Opens the thumbnail editor in the browser through a detached worker.
 * The worker outlives the Raycast command, so the editor keeps working
 * while Raycast is closed; its progress is read from the status file.
 * When the editor is closed, Raycast reopens on the review of the same video.
 */
export function startEditor(params: Omit<EditorRequest, 'returnDeeplink'>, videoId: string): void {
  const request: EditorRequest = { ...params, returnDeeplink: reviewDeeplink(videoId) }
  writeEditorStatus(request.videoPath, { state: 'running', overlay: request.overlay })

  // process.execPath is the Node runtime Raycast uses for extensions, so no separate Node install is needed.
  const child = spawn(process.execPath, [WORKER_SCRIPT, environment.assetsPath, JSON.stringify(request)], {
    detached: true,
    stdio: 'ignore',
  })
  child.unref()

  if (!child.pid) {
    writeEditorStatus(request.videoPath, {
      state: 'error',
      overlay: request.overlay,
      message: 'Failed to start the thumbnail editor',
    })
    throw new Error('Failed to start the thumbnail editor')
  }
}
