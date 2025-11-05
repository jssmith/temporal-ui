/**
 * Helper to record reset point markers in workflow history using local activities.
 *
 * This approach uses a local activity to create a marker in the workflow history.
 * Local activities execute inline and their completion creates a MarkerRecorded event,
 * which the UI can find and use for reset operations.
 */

import { proxyLocalActivities } from '@temporalio/workflow';

/**
 * Interface for reset point marker activity.
 */
export interface ResetPointMarkerActivity {
  resetPointMarker(
    name: string,
  ): Promise<{ marker_type: string; name: string }>;
}

/**
 * Local activity implementation that records a reset point marker.
 *
 * This activity does minimal work - it just returns the marker data.
 * The important part is that its execution creates a LocalActivityMarkerRecorded
 * event in the workflow history that the CLI can find.
 */
export async function resetPointMarkerActivity(
  name: string,
): Promise<{ marker_type: string; name: string }> {
  return {
    marker_type: 'temporal-reset-point',
    name,
  };
}

// Create a proxy for local activities with a very short timeout
const { resetPointMarker } = proxyLocalActivities<ResetPointMarkerActivity>({
  startToCloseTimeout: '1s',
  localRetryThreshold: '0s', // Don't retry
});

/**
 * Record a reset point marker in the workflow history using a local activity.
 *
 * This executes a local activity that creates a MarkerRecorded event in the
 * workflow history. The UI can find these markers by looking for local activity
 * completions with the activity name "temporal-reset-point".
 *
 * @param name - The name of the reset point marker
 *
 * @example
 * ```ts
 * await recordResetPoint('after-payment');
 * ```
 */
export async function recordResetPoint(name: string): Promise<void> {
  if (!name) {
    throw new Error('Reset point name cannot be empty');
  }

  // Execute a local activity to create the marker
  // Local activities run inline with the workflow task and create markers in history
  await resetPointMarker(name);
}
