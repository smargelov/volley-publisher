// Detached thumbnail editor worker.
//
// Spawned by the Raycast UI with `detached: true` so it outlives the command:
// it serves the editor page until the user saves or cancels in the browser.
// Arguments: <assets dir> <EditorRequest as JSON>.
import { execFile } from 'node:child_process'
import {
  extractPreviewFrames,
  loadCropChoice,
  probeFile,
  renderBaseFrame,
  runThumbnailSession,
  setAssetsDir,
  type PreviewFrame,
} from '../lib/core'
import { writeEditorStatus, type EditorRequest } from '../lib/editor-status'
import { extendToolsPath } from '../lib/tools-path'

async function run(request: EditorRequest): Promise<void> {
  const file = await probeFile(request.videoPath)

  let frames: PreviewFrame[] = []
  if (request.momentSec !== null) {
    frames = await extractPreviewFrames(file, request.momentSec)
    if (frames.length === 0) throw new Error('No frames could be extracted at that moment')
  } else {
    const saved = await loadCropChoice(file.path)
    if (!saved) throw new Error('No saved frame to reuse: pick a moment first')
    await renderBaseFrame(file, saved.timeSec, saved.crop)
  }

  const thumbnail = await runThumbnailSession({ file, frames, overlay: request.overlay })
  writeEditorStatus(request.videoPath, { state: thumbnail ? 'done' : 'cancelled', overlay: request.overlay })

  // Saved or cancelled, the user is done in the browser: bring Raycast back.
  if (request.returnDeeplink) {
    execFile('open', [request.returnDeeplink], () => {})
  }
}

const [assetsDir, requestJson] = process.argv.slice(2)
if (!assetsDir || !requestJson) {
  process.exit(2)
}

extendToolsPath()
setAssetsDir(assetsDir)
const request = JSON.parse(requestJson) as EditorRequest

run(request).catch((error: unknown) => {
  writeEditorStatus(request.videoPath, {
    state: 'error',
    overlay: request.overlay,
    message: error instanceof Error ? error.message : String(error),
  })
  process.exitCode = 1
})
