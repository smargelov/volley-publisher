// Detached upload worker.
//
// Spawned by the Raycast UI with `detached: true` so a long upload outlives the command.
// Progress goes to the status file the UI reads. Argument: <UploadRequest as JSON>.
import { execFile } from 'node:child_process'
import path from 'node:path'
import { loadStore, probeFile, saveStore, uploadVideo } from '../lib/core'
import { extendToolsPath } from '../lib/tools-path'
import { writeUploadStatus, type UploadRequest } from '../lib/upload-status'

/** The status file is rewritten at most this often while bytes are flowing. */
const PROGRESS_INTERVAL_MS = 1000

function notify(message: string): void {
  const script = `display notification ${JSON.stringify(message)} with title "Volley Publisher"`
  execFile('osascript', ['-e', script], () => {})
}

async function run(request: UploadRequest): Promise<void> {
  const file = await probeFile(request.videoPath)
  const base = { privacy: request.privacy, totalBytes: file.sizeBytes, pid: process.pid }
  let sentBytes = 0
  let lastWrite = 0

  // Cancelling from Raycast sends SIGTERM; the session stays on YouTube's side, so the upload can be resumed.
  process.on('SIGTERM', () => {
    writeUploadStatus(request.videoPath, { ...base, pid: undefined, state: 'cancelled', sentBytes })
    process.exit(0)
  })

  writeUploadStatus(request.videoPath, { ...base, state: 'running', sentBytes })
  const { videoId } = await uploadVideo(
    file.path,
    {
      // Same placeholder title YouTube Studio gives a fresh upload; the details form replaces it.
      title: path.basename(file.fileName, path.extname(file.fileName)),
      description: '',
      tags: [],
      recordingDate: file.recordedAt,
      privacyStatus: request.privacy,
    },
    {
      onProgress: (sent) => {
        sentBytes = sent
        if (Date.now() - lastWrite < PROGRESS_INTERVAL_MS) return
        lastWrite = Date.now()
        writeUploadStatus(request.videoPath, { ...base, state: 'running', sentBytes })
      },
    },
  )

  // The video list finds the source file of the new video through this record.
  const store = await loadStore()
  store.uploads[videoId] = file.fileName
  await saveStore(store)

  writeUploadStatus(request.videoPath, {
    ...base,
    pid: undefined,
    state: 'done',
    sentBytes: file.sizeBytes,
    videoId,
  })
  notify(`Uploaded ${file.fileName}`)
}

const [requestJson] = process.argv.slice(2)
if (!requestJson) {
  process.exit(2)
}

extendToolsPath()
const request = JSON.parse(requestJson) as UploadRequest

run(request).catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error)
  writeUploadStatus(request.videoPath, {
    state: 'error',
    privacy: request.privacy,
    sentBytes: 0,
    totalBytes: 0,
    message,
  })
  notify(`Upload failed: ${path.basename(request.videoPath)}`)
  process.exitCode = 1
})
