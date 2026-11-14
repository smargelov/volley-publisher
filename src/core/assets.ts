let assetsDir: string | undefined;

/**
 * Tells the core where the bundled logo and fonts live.
 * Every entry point (CLI, Raycast extension, worker) calls this once at startup,
 * because each of them ships the assets in a different place.
 */
export function setAssetsDir(dir: string): void {
  assetsDir = dir;
}

export function getAssetsDir(): string {
  if (!assetsDir) {
    throw new Error("Assets directory is not configured: call setAssetsDir() at startup.");
  }
  return assetsDir;
}
