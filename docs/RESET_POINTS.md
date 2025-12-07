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
2. UI builds a reset plan by discovering child workflows
3. Only children started **before** the reset point are considered
4. Only children that **have** the same reset point name are included
5. Children that **completed** before the reset point are skipped (server reconnection handles them)
6. Resets execute **bottom-up** (deepest children first, then parents)

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

### Integration Tests

```bash
pnpm test:integration -- workflow-reset-points.spec.ts
```

## Best Practices

1. **Name descriptively** - Use `after-payment` not `checkpoint1`
2. **Place after state changes** - After activities complete, not before
3. **Use same names across parent/child** - Required for cascade to work
4. **Don't overuse** - Only add where reset might actually be needed
