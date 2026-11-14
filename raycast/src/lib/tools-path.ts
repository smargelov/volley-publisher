// Raycast and detached workers start with a minimal PATH, so the usual
// Homebrew locations are added for ffmpeg and ffprobe.
const EXTRA_PATHS = ['/opt/homebrew/bin', '/usr/local/bin']

export function extendToolsPath(): void {
  const current = (process.env.PATH ?? '').split(':').filter(Boolean)
  process.env.PATH = [...EXTRA_PATHS.filter((p) => !current.includes(p)), ...current].join(':')
}
