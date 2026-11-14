// Single doorway to the shared core that lives in the repository root.
// It must stay free of `@raycast/api` imports: the detached worker loads it too.
export { setAssetsDir } from '../../../src/core/assets.js'
export { formatDuration, probeFile, type MediaFile, type SourceFile } from '../../../src/core/media.js'
export {
  loadStore,
  playlistKey,
  saveStore,
  slugify,
  type Discipline,
  type Store,
  type VideoAnswers,
} from '../../../src/core/store.js'
export { type ThumbnailOverlay } from '../../../src/core/text.js'
export {
  extractPreviewFrames,
  loadCropChoice,
  parseTimecode,
  renderBaseFrame,
  thumbDir,
  thumbnailPath,
  type PreviewFrame,
} from '../../../src/core/thumbnail.js'
export {
  adoptAnswers,
  applyPlan,
  buildPlan,
  findExpiredSources,
  findLocalFile,
  listChannelVideos,
  listPendingUploads,
  rememberAnswers,
  resolvePlayersAuto,
  tidyInbox,
  trackPublicVideos,
  translateStageAndNotes,
  type ChannelVideo,
  type VideoPlan,
} from '../../../src/core/workflow.js'
export {
  createPlaylist,
  listPlaylists,
  setPrivacyStatus,
  type Playlist,
  type PrivacyStatus,
} from '../../../src/core/youtube.js'
export { uploadVideo } from '../../../src/core/upload.js'
export { runThumbnailSession } from '../../../src/ui/cropSession.js'
