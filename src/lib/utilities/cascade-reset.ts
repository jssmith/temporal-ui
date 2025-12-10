import { fetchAllEvents } from '$lib/services/events-service';
import type { WorkflowEvents } from '$lib/types/events';
import {
  extractResetPoints,
  findResetPointEventId,
} from '$lib/utilities/extract-reset-points';
import {
  isChildWorkflowExecutionCompletedEvent,
  isChildWorkflowExecutionStartedEvent,
  isStartChildWorkflowExecutionInitiatedEvent,
  isWorkflowTaskCompletedEvent,
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

export type DiscoveredResetPoint = {
  name: string;
  displayName: string;
  source: 'parent' | 'child';
  childWorkflowIds?: string[];
  childPaths?: string[];
};

/**
 * Extracts ALL child workflows from history (no event cutoff).
 * Used for discovering child reset points when cascade is enabled.
 */
export function extractAllChildren(events: WorkflowEvents): ChildRef[] {
  const childMap = new Map<string, ChildRef>();

  for (const event of events) {
    if (isStartChildWorkflowExecutionInitiatedEvent(event)) {
      const attr = event.startChildWorkflowExecutionInitiatedEventAttributes;
      const workflowId = attr?.workflowId;
      if (workflowId) {
        childMap.set(event.id, {
          workflowId,
          runId: '',
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
    }
  }

  return Array.from(childMap.values()).filter((child) => child.runId !== '');
}

/**
 * Finds the WorkflowTaskCompleted event ID after a child workflow was started.
 * Used for propagate-up reset when the reset point is only in the child.
 */
export function findParentResetPointForChild(
  parentEvents: WorkflowEvents,
  childWorkflowId: string,
): string | null {
  let foundChildStart = false;

  for (const event of parentEvents) {
    if (isStartChildWorkflowExecutionInitiatedEvent(event)) {
      const attr = event.startChildWorkflowExecutionInitiatedEventAttributes;
      if (attr?.workflowId === childWorkflowId) {
        foundChildStart = true;
      }
    }

    if (foundChildStart && isWorkflowTaskCompletedEvent(event)) {
      return event.id;
    }
  }

  return null;
}

/**
 * Recursively discovers all reset points from a workflow and its children.
 * Returns reset points from parent and all children, with child markers prefixed.
 */
async function discoverResetPointsRecursive(
  namespace: string,
  workflowId: string,
  runId: string,
  pathPrefix: string,
  results: DiscoveredResetPoint[],
): Promise<void> {
  try {
    const events = await fetchAllEvents({
      namespace,
      workflowId,
      runId,
      sort: 'ascending',
      setHistory: false,
    });

    const resetPoints = extractResetPoints(events);
    const isParent = pathPrefix === '';

    for (const rp of resetPoints) {
      results.push({
        name: rp.name,
        displayName: isParent ? rp.name : `${pathPrefix}/${rp.name}`,
        source: isParent ? 'parent' : 'child',
        childWorkflowIds: isParent ? undefined : [workflowId],
        childPaths: isParent ? undefined : [pathPrefix],
      });
    }

    const children = extractAllChildren(events);
    for (const child of children) {
      const childPath = isParent
        ? child.workflowId
        : `${pathPrefix}/${child.workflowId}`;
      await discoverResetPointsRecursive(
        namespace,
        child.workflowId,
        child.runId,
        childPath,
        results,
      );
    }
  } catch (err) {
    console.error(`Failed to discover reset points for ${workflowId}:`, err);
  }
}

/**
 * Groups discovered reset points by marker name.
 * Parent markers remain separate, child markers with the same name are grouped together.
 * Display format for grouped child markers: "marker_name ([workflow1, workflow2])"
 * Deduplicates workflow IDs when the same marker appears multiple times in a child.
 */
export function groupResetPointsByName(
  points: DiscoveredResetPoint[],
): DiscoveredResetPoint[] {
  const parentPoints: DiscoveredResetPoint[] = [];
  const childPointsByName = new Map<
    string,
    { workflowIds: Set<string>; paths: Set<string> }
  >();

  for (const point of points) {
    if (point.source === 'parent') {
      // Parent markers stay separate
      parentPoints.push(point);
    } else {
      // Group child markers by name, using Sets to deduplicate
      const existing = childPointsByName.get(point.name);
      if (existing) {
        // Merge into existing group (Sets automatically deduplicate)
        for (const id of point.childWorkflowIds || []) {
          existing.workflowIds.add(id);
        }
        for (const path of point.childPaths || []) {
          existing.paths.add(path);
        }
      } else {
        // Create new group with Sets for deduplication
        childPointsByName.set(point.name, {
          workflowIds: new Set(point.childWorkflowIds || []),
          paths: new Set(point.childPaths || []),
        });
      }
    }
  }

  // Convert Sets back to arrays and build final DiscoveredResetPoint objects
  const childPoints: DiscoveredResetPoint[] = [];
  for (const [name, data] of childPointsByName.entries()) {
    const workflowIds = Array.from(data.workflowIds);
    const paths = Array.from(data.paths);

    let displayName: string;
    if (workflowIds.length > 1) {
      // Format: "marker_name ([workflow1, workflow2])"
      displayName = `${name} ([${workflowIds.join(', ')}])`;
    } else if (workflowIds.length === 1) {
      // Single child: keep path-based format for clarity
      const path = paths[0] || workflowIds[0];
      displayName = `${path}/${name}`;
    } else {
      displayName = name;
    }

    childPoints.push({
      name,
      displayName,
      source: 'child',
      childWorkflowIds: workflowIds,
      childPaths: paths,
    });
  }

  // Return parent markers first, then grouped child markers
  return [...parentPoints, ...childPoints];
}

/**
 * Discovers all reset points from a workflow and its children.
 * Parent markers are shown with just the name, child markers with the same name are grouped.
 */
export async function discoverAllResetPoints(
  namespace: string,
  workflowId: string,
  runId: string,
): Promise<DiscoveredResetPoint[]> {
  const results: DiscoveredResetPoint[] = [];
  await discoverResetPointsRecursive(namespace, workflowId, runId, '', results);
  return groupResetPointsByName(results);
}

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
 *
 * Supports "propagate up": if the parent doesn't have the reset point but a child does,
 * the parent's reset point is calculated as "after child was started".
 */
async function discoverCascade(
  namespace: string,
  workflowId: string,
  runId: string,
  resetPointName: string,
  depth: number,
  plan: CascadeResetPlan,
  _parentEvents?: WorkflowEvents,
): Promise<boolean> {
  try {
    const events = await fetchAllEvents({
      namespace,
      workflowId,
      runId,
      sort: 'ascending',
      setHistory: false,
    });

    const eventId = findResetPointEventId(events, resetPointName);

    if (eventId) {
      plan.resets.push({
        workflowId,
        runId,
        eventId,
        depth,
      });

      const children = extractChildrenBeforeEvent(events, eventId);
      for (const child of children) {
        await discoverCascade(
          namespace,
          child.workflowId,
          child.runId,
          resetPointName,
          depth + 1,
          plan,
          events,
        );
      }
      return true;
    }

    // Propagate up: parent doesn't have the marker, check children
    const allChildren = extractAllChildren(events);
    let foundInChild = false;
    let childWithMarker: ChildRef | null = null;

    for (const child of allChildren) {
      const childHasMarker = await discoverCascade(
        namespace,
        child.workflowId,
        child.runId,
        resetPointName,
        depth + 1,
        plan,
        events,
      );

      if (childHasMarker && !foundInChild) {
        foundInChild = true;
        childWithMarker = child;
      }
    }

    if (foundInChild && childWithMarker) {
      // Calculate parent's reset point as "after child was started"
      const parentResetEventId = findParentResetPointForChild(
        events,
        childWithMarker.workflowId,
      );

      if (parentResetEventId) {
        plan.resets.push({
          workflowId,
          runId,
          eventId: parentResetEventId,
          depth,
        });
        return true;
      }
    }

    plan.skipped.push(workflowId);
    return false;
  } catch (err) {
    console.error(`Failed to discover cascade for ${workflowId}:`, err);
    plan.skipped.push(workflowId);
    return false;
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
