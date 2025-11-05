import type { WorkflowEvents } from '$lib/types/events';
import { decodePayload } from '$lib/utilities/decode-payload';
import {
  isMarkerRecordedEvent,
  isWorkflowTaskCompletedEvent,
} from '$lib/utilities/is-event-type';

export type ResetPoint = {
  name: string;
  eventId: string;
};

const RESET_POINT_MARKER_NAME = 'temporal-reset-point';
const RESET_POINT_NAME_KEY = 'name';
const SIDE_EFFECT_MARKER_NAME = 'SideEffect';
const SIDE_EFFECT_DATA_KEY = 'data';
const LOCAL_ACTIVITY_MARKER_NAME = 'core_local_activity';
const LOCAL_ACTIVITY_RESULT_KEY = 'result';

/**
 * Finds the next WorkflowTaskCompleted event after the given marker event.
 * Returns null if no subsequent workflow task is found.
 */
function findNextWorkflowTaskCompleted(
  events: WorkflowEvents,
  markerEventIndex: number,
): string | null {
  // Scan forward from the marker event to find the next WorkflowTaskCompleted
  for (let i = markerEventIndex + 1; i < events.length; i++) {
    const event = events[i];
    if (isWorkflowTaskCompletedEvent(event)) {
      return event.id;
    }
  }
  return null;
}

/**
 * Extracts reset points from workflow event history.
 * Searches for three types of markers:
 * 1. Native reset point markers (markerName: "temporal-reset-point")
 * 2. SideEffect markers containing reset point data
 * 3. LocalActivity markers containing reset point metadata
 *
 * Returns array of reset points with their names and corresponding event IDs.
 * The event ID returned is the next WorkflowTaskCompleted event AFTER the marker,
 * which ensures the workflow resumes after the reset point, not at it.
 */
export function extractResetPoints(events: WorkflowEvents): ResetPoint[] {
  const resetPoints: ResetPoint[] = [];

  for (let i = 0; i < events.length; i++) {
    const event = events[i];
    if (!isMarkerRecordedEvent(event)) {
      continue;
    }

    const attributes = event.markerRecordedEventAttributes;
    const markerName = attributes?.markerName;
    const details = attributes?.details;
    const workflowTaskCompletedEventId =
      attributes?.workflowTaskCompletedEventId;

    if (!markerName || !details || !workflowTaskCompletedEventId) {
      continue;
    }

    // Check for native reset point marker
    if (markerName === RESET_POINT_MARKER_NAME) {
      const nameField = details[RESET_POINT_NAME_KEY];
      const payloads = nameField?.payloads;
      if (payloads && Array.isArray(payloads) && payloads.length > 0) {
        try {
          const name = decodePayload(payloads[0], true) as string;
          if (name) {
            // Find the next WorkflowTaskCompleted event after this marker
            const nextTaskEventId = findNextWorkflowTaskCompleted(events, i);
            if (nextTaskEventId) {
              resetPoints.push({
                name,
                eventId: nextTaskEventId,
              });
            } else {
              console.warn(
                `Reset point "${name}" has no subsequent workflow task, skipping`,
              );
            }
          }
        } catch (err) {
          console.warn('Failed to decode reset point marker name:', err);
        }
      }
      continue;
    }

    // Check for SideEffect marker with reset point data
    if (markerName === SIDE_EFFECT_MARKER_NAME) {
      const dataField = details[SIDE_EFFECT_DATA_KEY];
      const payloads = dataField?.payloads;
      if (payloads && Array.isArray(payloads) && payloads.length > 0) {
        try {
          const data = decodePayload(payloads[0], true) as {
            Type?: string;
            Name?: string;
          };
          if (data?.Type === RESET_POINT_MARKER_NAME && data?.Name) {
            // Find the next WorkflowTaskCompleted event after this marker
            const nextTaskEventId = findNextWorkflowTaskCompleted(events, i);
            if (nextTaskEventId) {
              resetPoints.push({
                name: data.Name,
                eventId: nextTaskEventId,
              });
            } else {
              console.warn(
                `Reset point "${data.Name}" has no subsequent workflow task, skipping`,
              );
            }
          }
        } catch (err) {
          console.warn('Failed to decode SideEffect marker data:', err);
        }
      }
      continue;
    }

    // Check for Local Activity marker used as reset point
    if (markerName === LOCAL_ACTIVITY_MARKER_NAME) {
      const resultField = details[LOCAL_ACTIVITY_RESULT_KEY];
      const payloads = resultField?.payloads;
      if (payloads && Array.isArray(payloads) && payloads.length > 0) {
        try {
          const result = decodePayload(payloads[0], true) as {
            marker_type?: string;
            MarkerType?: string;
            name?: string;
            Name?: string;
          };
          const markerType = result?.marker_type || result?.MarkerType;
          const name = result?.name || result?.Name;

          if (markerType === RESET_POINT_MARKER_NAME && name) {
            // Find the next WorkflowTaskCompleted event after this marker
            const nextTaskEventId = findNextWorkflowTaskCompleted(events, i);
            if (nextTaskEventId) {
              resetPoints.push({
                name,
                eventId: nextTaskEventId,
              });
            } else {
              console.warn(
                `Reset point "${name}" has no subsequent workflow task, skipping`,
              );
            }
          }
        } catch (err) {
          console.warn('Failed to decode local activity marker result:', err);
        }
      }
    }
  }

  return resetPoints;
}

/**
 * Finds a specific reset point marker in the event history and returns its event ID.
 * Returns null if the reset point is not found.
 */
export function findResetPointEventId(
  events: WorkflowEvents,
  resetPointName: string,
): string | null {
  const resetPoints = extractResetPoints(events);
  const resetPoint = resetPoints.find((rp) => rp.name === resetPointName);
  return resetPoint?.eventId || null;
}
