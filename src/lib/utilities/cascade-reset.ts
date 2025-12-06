import { fetchAllEvents } from '$lib/services/events-service';
import type { WorkflowEvents } from '$lib/types/events';
import { findResetPointEventId } from '$lib/utilities/extract-reset-points';
import {
  isChildWorkflowExecutionCompletedEvent,
  isChildWorkflowExecutionStartedEvent,
  isStartChildWorkflowExecutionInitiatedEvent,
} from '$lib/utilities/is-event-type';

export type ChildRef = {
  workflowId: string;
  runId: string;
};

export type ResetInfo = {
  workflowId: string;
  runId: string;
  eventId: string;
  depth: number;
};

export type CascadeResetPlan = {
  resets: ResetInfo[];
  skipped: string[];
};

/**
 * Extracts child workflows that were started but NOT completed before the specified event ID.
 *
 * Children that completed before the reset point don't need to be reset because:
 * - Their results are already in the parent's history
 * - The parent will replay those results
 * - Server reconnection will handle reconnecting the parent to the existing child
 *
 * Only children that are still in-progress at the reset point need cascade consideration.
 */
export function extractChildrenBeforeEvent(
  events: WorkflowEvents,
  beforeEventId: string,
): ChildRef[] {
  const beforeEventIdNum = parseInt(beforeEventId, 10);
  const childMap = new Map<string, ChildRef>();
  const completedChildRunIds = new Set<string>();

  for (const event of events) {
    const eventId = parseInt(event.id, 10);

    if (eventId >= beforeEventIdNum) {
      break;
    }

    if (isStartChildWorkflowExecutionInitiatedEvent(event)) {
      const attr = event.startChildWorkflowExecutionInitiatedEventAttributes;
      const workflowId = attr?.workflowId;
      if (workflowId) {
        childMap.set(event.id, {
          workflowId,
          runId: '', // Will be filled when we find the started event
        });
      }
    } else if (isChildWorkflowExecutionStartedEvent(event)) {
      const attr = event.childWorkflowExecutionStartedEventAttributes;
      const initiatedEventId = attr?.initiatedEventId;
      const runId = attr?.workflowExecution?.runId;

      if (initiatedEventId && runId) {
        const child = childMap.get(String(initiatedEventId));
        if (child) {
          child.runId = runId;
        }
      }
    } else if (isChildWorkflowExecutionCompletedEvent(event)) {
      // Track completed children - these don't need to be reset
      const attr = event.childWorkflowExecutionCompletedEventAttributes;
      const runId = attr?.workflowExecution?.runId;
      if (runId) {
        completedChildRunIds.add(runId);
      }
    }
  }

  // Return only children that:
  // 1. Have both workflowId and runId (were actually started)
  // 2. Did NOT complete before the reset point (need cascade reset)
  return Array.from(childMap.values()).filter(
    (child) => child.runId !== '' && !completedChildRunIds.has(child.runId),
  );
}

/**
 * Recursively builds a cascading reset plan.
 * Discovers all child workflows and finds the same reset point in each.
 */
async function discoverCascade(
  namespace: string,
  workflowId: string,
  runId: string,
  resetPointName: string,
  depth: number,
  plan: CascadeResetPlan,
): Promise<void> {
  try {
    // Fetch workflow history
    const events = await fetchAllEvents({
      namespace,
      workflowId,
      runId,
      sort: 'ascending',
      setHistory: false, // Don't update the global store
    });

    // Find reset point marker
    const eventId = findResetPointEventId(events, resetPointName);

    if (!eventId) {
      plan.skipped.push(workflowId);
      return;
    }

    // Add to reset plan
    plan.resets.push({
      workflowId,
      runId,
      eventId,
      depth,
    });

    // Find and recurse into children
    const children = extractChildrenBeforeEvent(events, eventId);

    for (const child of children) {
      await discoverCascade(
        namespace,
        child.workflowId,
        child.runId,
        resetPointName,
        depth + 1,
        plan,
      );
    }
  } catch (err) {
    console.error(`Failed to discover cascade for ${workflowId}:`, err);
    plan.skipped.push(workflowId);
  }
}

/**
 * Builds a cascading reset plan by recursively discovering child workflows.
 * Returns a plan sorted by depth (deepest first) for safe execution.
 */
export async function buildCascadingPlan(
  namespace: string,
  workflowId: string,
  runId: string,
  resetPointName: string,
): Promise<CascadeResetPlan> {
  const plan: CascadeResetPlan = {
    resets: [],
    skipped: [],
  };

  await discoverCascade(namespace, workflowId, runId, resetPointName, 0, plan);

  // Sort by depth (deepest first) to ensure children are reset before parents
  plan.resets.sort((a, b) => b.depth - a.depth);

  return plan;
}
