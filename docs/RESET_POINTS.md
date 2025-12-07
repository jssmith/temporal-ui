# Workflow Reset Points

Reset workflows to named checkpoints instead of event IDs. This feature allows users to reset workflows to specific points in their execution history using semantic names rather than opaque event numbers.

## Overview

Reset points are markers recorded in workflow history that identify safe points to reset a workflow. The UI extracts these markers and presents them as reset options alongside traditional event ID-based reset.

## How Reset Points Work

### Recording Reset Points (Workflow Code)

Workflows record reset points using SDK-specific APIs. The recording creates a `MarkerRecorded` event in the workflow history.

**TypeScript Example:**

```typescript
import { recordResetPoint } from './reset-point-helper';

export async function orderWorkflow(orderId: string) {
  await validateOrder(orderId);
  await recordResetPoint('after-validation');

  await processPayment(orderId);
  await recordResetPoint('after-payment');

  await shipOrder(orderId);
}
```

### Detecting Reset Points (UI)

The UI detects three types of reset point markers:

1. **Native markers** - `markerName: "temporal-reset-point"` with name in details
2. **SideEffect markers** - `markerName: "SideEffect"` with `Type: "temporal-reset-point"` in data
3. **LocalActivity markers** - `markerName: "core_local_activity"` with `marker_type: "temporal-reset-point"` in result

See `src/lib/utilities/extract-reset-points.ts` for implementation.

### Resetting to a Point

When a user selects a reset point:

1. UI finds the `workflowTaskCompletedEventId` from the marker's attributes
2. UI calls the standard `ResetWorkflowExecution` API with that event ID
3. Server creates a new workflow run branching from that point

## Cascading Reset

Cascade reset extends reset-by-point to automatically reset child workflows that share the same reset point name.

### How It Works

1. User selects a reset point and enables "Cascade to children"
2. UI discovers reset points from parent **and all children** (shown in dropdown)
3. Child markers are prefixed with their path (e.g., `child-1/after-fetch`)
4. When a child marker is selected, parent reset point is calculated automatically
5. Resets execute **bottom-up** (deepest children first, then parents)

### Child Reset Point Discovery

When the cascade checkbox is enabled:

1. UI fetches the parent workflow's history and extracts its reset points
2. UI recursively fetches child workflow histories
3. Child reset points are added to the dropdown with path prefix
4. User can select either parent or child markers

Example dropdown after enabling cascade:

- `after-payment` (parent marker)
- `child-1/after-fetch` (marker in child-1)
- `child-1/grandchild-1/after-process` (marker in grandchild)

### Propagate Up

When a reset point exists **only in a child workflow** (not in the parent):

1. User selects the child marker (e.g., `child-1/after-fetch`)
2. UI calculates parent's reset point as "WorkflowTaskCompleted after child was started"
3. Both parent and child are added to the reset plan
4. Bottom-up execution ensures child resets first, then parent

This allows resetting to any marker in the workflow tree, not just markers in the parent.

### Conservative Reset (Race Condition Prevention)

To avoid race conditions where a child might complete between planning and execution, the parent is **always reset** when propagating up from a child marker - even if the child appears to be in progress. This ensures the parent will be in a consistent state to reconnect with the reset child.

### Why Bottom-Up Order?

The Temporal server uses `OriginalExecutionRunId` to reconnect parent and child workflows after reset. Bottom-up order ensures:

1. Child resets complete first → new child run IDs exist
2. Parent reset happens → server reconnects parent to reset children
3. Results flow correctly through the workflow tree

### Server Reconnection

When a parent workflow resets and tries to start a child that was already started in the original execution:

- Server checks if a reset child exists with matching `OriginalExecutionRunId`
- If found, parent connects to the reset child (not the original)
- Child results are properly returned to the reset parent

This is why children that **completed** before the reset point don't need explicit reset - the parent will replay their results from its own history.

## Implementation Files

### Core Utilities

- `src/lib/utilities/extract-reset-points.ts` - Extract reset points from workflow history
- `src/lib/utilities/cascade-reset.ts` - Build cascading reset plans
  - `discoverAllResetPoints()` - Discover all markers from parent + children
  - `findParentResetPointForChild()` - Calculate parent reset point for propagate-up
  - `extractAllChildren()` - Get all children (for marker discovery)
  - `buildCascadingPlan()` - Build the full reset plan with propagate-up support

### Stores

- `src/lib/stores/reset-points.ts` - Svelte store derived from event history

### Services

- `src/lib/services/workflow-service.ts` - `resetWorkflowByPoint()` and `cascadeResetWorkflow()` functions

### UI Components

- `src/lib/components/workflow/client-actions/reset-confirmation-modal.svelte` - Reset modal with point selection

### Test Workflows

- `temporal/reset-point-helper.ts` - TypeScript helper for recording reset points
- `temporal/workflows.ts` - Test workflows with reset points

## Testing

### Unit Tests

```bash
pnpm test -- extract-reset-points.test.ts --run
pnpm test -- cascade-reset.test.ts --run
```

**Covered scenarios:**

- Marker detection for all three marker types (native, SideEffect, LocalActivity)
- Finding next WorkflowTaskCompleted event
- Child extraction with various event patterns
- Propagate-up reset point calculation
- Edge cases (no children, completed children, missing markers)

### Integration Tests

```bash
pnpm test:integration -- workflow-reset-points.spec.ts
```

**Covered scenarios:**

- Reset point detection from UI (via modal)
- Cascading reset with child workflows
- Activity replay verification (activities before marker not re-executed)
- **Propagate-up tests:**
  - Child marker discovery when cascade checkbox enabled
  - Loading indicator during discovery
  - Propagate-up reset execution (both parent and child reset)
  - Parent + child marker visibility in dropdown
  - Multi-level hierarchy documentation
  - Error handling for deleted/missing children

## Best Practices

1. **Name descriptively** - Use `after-payment` not `checkpoint1`
2. **Place after state changes** - After activities complete, not before
3. **Use same names across parent/child** - Required for cascade to work
4. **Don't overuse** - Only add where reset might actually be needed
