import './lib/setup'
import { environment, LaunchType, showHUD } from '@raycast/api'
import { maintenanceSummary, runMaintenance } from './lib/maintenance'

/**
 * Housekeeping without opening the list. Raycast runs it in the background
 * on the interval from the manifest; it can also be launched by hand.
 */
export default async function Command() {
  const launchedByUser = environment.launchType === LaunchType.UserInitiated
  try {
    const result = await runMaintenance()
    if (launchedByUser) await showHUD(maintenanceSummary(result) ?? 'Nothing to clean up')
  } catch (error) {
    // Background runs stay silent: an expired token or no network is not worth interrupting for.
    if (launchedByUser) await showHUD(`Cleanup failed: ${error instanceof Error ? error.message : String(error)}`)
  }
}
