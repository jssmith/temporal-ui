import { derived } from 'svelte/store';

import { fullEventHistory } from '$lib/stores/events';
import { extractResetPoints } from '$lib/utilities/extract-reset-points';

/**
 * Store containing all reset points found in the workflow history.
 * Derived from fullEventHistory by extracting reset point markers.
 */
export const resetPoints = derived(fullEventHistory, ($events) => {
  return extractResetPoints($events);
});
