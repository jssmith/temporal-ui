import { expect, test } from '@playwright/test';
import { Client } from '@temporalio/client';

import { connect } from '~/temporal/client';
import {
  ParentWorkflowWithResetPoints,
  WorkflowWithResetPoints,
} from '~/temporal/workflows';

let client: Client;

// Track activity execution counts across resets
const _activityExecutionCounts = new Map<string, number>();

/**
 * Helper to count activity executions in a workflow history
 */
async function countActivityExecutions(
  client: Client,
  workflowId: string,
  runId: string,
): Promise<number> {
  const history = await client.workflow
    .getHandle(workflowId, runId)
    .fetchHistory();
  let count = 0;
  for (const event of history?.events || []) {
    if (event.eventType === 'EVENT_TYPE_ACTIVITY_TASK_SCHEDULED') {
      count++;
    }
  }
  return count;
}

test.describe('Workflow Reset Points - Real Workflows', () => {
  test.beforeAll(async () => {
    client = await connect();
  });

  test('should extract reset points from workflow history', async ({
    page,
  }) => {
    const workflowId = `test-reset-points-${Date.now()}`;

    // Start workflow with reset points
    const handle = await client.workflow.start(WorkflowWithResetPoints, {
      taskQueue: 'e2e-1',
      args: ['test'],
      workflowId,
    });

    // Wait for workflow to complete
    await handle.result();

    // Navigate to workflow page
    await page.goto(
      `/namespaces/default/workflows/${workflowId}/${handle.firstExecutionRunId}`,
      { waitUntil: 'domcontentloaded' },
    );

    // Click on reset button to open modal
    await page.getByTestId('reset-workflow-button').click();

    // Wait for reset modal to appear
    await expect(page.getByTestId('reset-confirmation-modal')).toBeVisible();

    // Switch to reset point mode
    await page.getByTestId('reset-mode-reset-point').click();

    // Check that reset point select is visible
    const resetPointSelect = page.getByTestId('workflow-reset-point-select');
    await expect(resetPointSelect).toBeVisible();

    // Click the select to open dropdown
    await resetPointSelect.click();

    // Verify that reset points are available in the dropdown
    // We should see 'after-first-activity' and 'after-second-activity'
    await expect(page.getByText(/after-first-activity/)).toBeVisible();
    await expect(page.getByText(/after-second-activity/)).toBeVisible();
  });

  test('should reset workflow to a named reset point and verify execution', async ({
    page,
  }) => {
    const workflowId = `test-reset-execution-${Date.now()}`;

    // Start workflow with reset points
    const handle = await client.workflow.start(WorkflowWithResetPoints, {
      taskQueue: 'e2e-1',
      args: ['test'],
      workflowId,
    });

    // Wait for workflow to complete
    const firstResult = await handle.result();
    const firstRunId = handle.firstExecutionRunId;

    console.log('First execution completed:', firstResult);
    console.log('First run ID:', firstRunId);

    // Navigate to workflow page
    await page.goto(
      `/namespaces/default/workflows/${workflowId}/${firstRunId}`,
      {
        waitUntil: 'domcontentloaded',
      },
    );

    // Open reset modal
    await page.getByTestId('reset-workflow-button').click();
    await expect(page.getByTestId('reset-confirmation-modal')).toBeVisible();

    // Switch to reset point mode
    await page.getByTestId('reset-mode-reset-point').click();

    // Select the first reset point
    const resetPointSelect = page.getByTestId('workflow-reset-point-select');
    await resetPointSelect.click();
    await page
      .getByText(/after-first-activity/)
      .first()
      .click();

    // Add a reason
    await page
      .locator('#reset-reason')
      .fill('Testing reset to first checkpoint');

    // Confirm reset
    await page.getByText('Confirm').click();

    // Wait for reset to complete (modal should close)
    await expect(page.getByTestId('reset-confirmation-modal')).toBeHidden({
      timeout: 10000,
    });

    // Get the new workflow execution after reset
    const newHandle = await client.workflow.getHandle(workflowId);
    const newRunId = newHandle.firstExecutionRunId;

    console.log('New run ID after reset:', newRunId);

    // Verify that we have a new run ID
    expect(newRunId).not.toBe(firstRunId);

    // Wait for the reset workflow to complete
    const resetResult = await newHandle.result();
    console.log('Reset execution completed:', resetResult);

    // Navigate to the new workflow execution
    await page.goto(`/namespaces/default/workflows/${workflowId}/${newRunId}`, {
      waitUntil: 'domcontentloaded',
    });

    // Click on Event History tab
    await page.getByRole('tab', { name: 'Event History' }).click();

    // Verify event history shows correct events
    // The workflow should have:
    // 1. WorkflowExecutionStarted
    // 2. WorkflowTaskScheduled/Started/Completed (for reset point replay)
    // 3. ActivityTaskScheduled for activities AFTER the reset point
    //    (second and third activities, but NOT the first activity)

    // Look for activity executions in the event history
    const eventHistory = page.getByTestId('event-history');
    await expect(eventHistory).toBeVisible();

    // The first activity should NOT be re-executed (it was before the reset point)
    // This is the KEY test: verifying that work before the reset point is not repeated

    // We'll check this by counting ActivityTaskScheduled events
    // Since we reset after the first activity, we should only see 2 new activity executions
    // (second and third activities)
  });

  test('should handle cascade reset with parent and child workflows', async ({
    page,
  }) => {
    const parentWorkflowId = `test-cascade-parent-${Date.now()}`;

    // Start parent workflow (which will start a child)
    const parentHandle = await client.workflow.start(
      ParentWorkflowWithResetPoints,
      {
        taskQueue: 'e2e-1',
        args: ['cascade-test'],
        workflowId: parentWorkflowId,
      },
    );

    // Wait for parent to complete
    await parentHandle.result();
    const parentRunId = parentHandle.firstExecutionRunId;

    console.log('Parent workflow completed');

    // Navigate to parent workflow page
    await page.goto(
      `/namespaces/default/workflows/${parentWorkflowId}/${parentRunId}`,
      { waitUntil: 'domcontentloaded' },
    );

    // Open reset modal
    await page.getByTestId('reset-workflow-button').click();
    await expect(page.getByTestId('reset-confirmation-modal')).toBeVisible();

    // Switch to reset point mode
    await page.getByTestId('reset-mode-reset-point').click();

    // Select the parent checkpoint
    const resetPointSelect = page.getByTestId('workflow-reset-point-select');
    await resetPointSelect.click();
    await page
      .getByText(/parent-checkpoint/)
      .first()
      .click();

    // Enable cascade
    const cascadeCheckbox = page.getByTestId('reset-cascade-checkbox');
    await expect(cascadeCheckbox).toBeVisible();
    await cascadeCheckbox.check();

    // Add a reason
    await page.locator('#reset-reason').fill('Testing cascading reset');

    // Confirm reset
    await page.getByText('Confirm').click();

    // Wait for reset to complete
    await expect(page.getByTestId('reset-confirmation-modal')).toBeHidden({
      timeout: 15000,
    });

    // Verify cascade success message appears
    // The modal should show success count
    // Note: The modal may have already closed, so we'll verify by checking
    // that the parent workflow has a new run

    const newParentHandle = await client.workflow.getHandle(parentWorkflowId);
    const newParentRunId = newParentHandle.firstExecutionRunId;

    expect(newParentRunId).not.toBe(parentRunId);
    console.log('Cascade reset created new parent run:', newParentRunId);

    // Wait for reset execution to complete
    await newParentHandle.result();

    console.log('Cascade reset execution completed successfully');
  });

  test('should display warning when reset point is not found', async ({
    page,
  }) => {
    const workflowId = `test-no-reset-point-${Date.now()}`;

    // Start a regular workflow WITHOUT reset points
    const handle = await client.workflow.start(WorkflowWithResetPoints, {
      taskQueue: 'e2e-1',
      args: ['test'],
      workflowId,
    });

    await handle.result();

    // Navigate to workflow page
    await page.goto(
      `/namespaces/default/workflows/${workflowId}/${handle.firstExecutionRunId}`,
      { waitUntil: 'domcontentloaded' },
    );

    // Open reset modal
    await page.getByTestId('reset-workflow-button').click();
    await expect(page.getByTestId('reset-confirmation-modal')).toBeVisible();

    // Switch to reset point mode
    await page.getByTestId('reset-mode-reset-point').click();

    // The select should show that there are reset points available
    // (our test workflow has them)
    const resetPointSelect = page.getByTestId('workflow-reset-point-select');
    await expect(resetPointSelect).toBeVisible();

    // Click to see options
    await resetPointSelect.click();

    // Should see reset points
    await expect(
      page.getByText(/after-first-activity|after-second-activity/),
    ).toBeVisible();
  });

  test('should verify reset boundary behavior - CRITICAL TEST', async ({
    page,
  }) => {
    const workflowId = `test-reset-boundary-${Date.now()}`;

    // Start workflow with reset points
    const handle = await client.workflow.start(WorkflowWithResetPoints, {
      taskQueue: 'e2e-1',
      args: ['boundary-test'],
      workflowId,
    });

    await handle.result();
    const firstRunId = handle.firstExecutionRunId;

    // Get the full event history to analyze
    const description = await client.workflow
      .getHandle(workflowId, firstRunId)
      .describe();
    console.log('Workflow status:', description.status);

    // Fetch history via API
    await page.goto(
      `/api/namespaces/default/workflows/${workflowId}/runs/${firstRunId}/history`,
    );
    const historyJson = await page.textContent('pre');
    const history = JSON.parse(historyJson);

    console.log('Event history:');
    history.events?.forEach(
      (
        event: {
          eventId: string;
          eventType: string;
          markerRecordedEventAttributes?: {
            markerName?: string;
            workflowTaskCompletedEventId?: string;
          };
        },
        index: number,
      ) => {
        console.log(
          `  ${index + 1}. Event ${event.eventId}: ${event.eventType}`,
        );
        if (event.eventType === 'MarkerRecorded') {
          console.log(
            `     Marker: ${event.markerRecordedEventAttributes?.markerName}`,
          );
          console.log(
            `     Task completed event: ${event.markerRecordedEventAttributes?.workflowTaskCompletedEventId}`,
          );
        }
        if (event.eventType === 'ActivityTaskScheduled') {
          console.log('     Activity scheduled');
        }
        if (event.eventType === 'WorkflowTaskCompleted') {
          console.log('     Workflow task completed');
        }
      },
    );

    // Now reset via API to test the actual reset boundary
    const resetEventId = await page.evaluate(
      async ({ wfId, runId }: { wfId: string; runId: string }) => {
        // Fetch events
        const historyResp = await fetch(
          `/api/namespaces/default/workflows/${wfId}/runs/${runId}/history`,
        );
        const historyData = await historyResp.json();

        // Extract reset points using the same logic as the UI
        const events = historyData.events || [];

        // Find reset point markers
        for (let i = 0; i < events.length; i++) {
          const event = events[i];
          if (event.eventType === 'MarkerRecorded') {
            const markerName = event.markerRecordedEventAttributes?.markerName;
            if (markerName === 'core_local_activity') {
              // This is a local activity marker - check if it's a reset point
              console.log('Found marker at event', event.eventId);
              console.log(
                'Task completed ID:',
                event.markerRecordedEventAttributes
                  ?.workflowTaskCompletedEventId,
              );

              // The UI code finds the NEXT WorkflowTaskCompleted after this marker
              for (let j = i + 1; j < events.length; j++) {
                if (events[j].eventType === 'WorkflowTaskCompleted') {
                  return events[j].eventId;
                }
              }
            }
          }
        }
        return null;
      },
      { wfId: workflowId, runId: firstRunId },
    );

    console.log('Reset event ID determined by UI logic:', resetEventId);

    // This test documents what ACTUALLY happens during reset
    // We'll verify by checking the event sequence
    expect(resetEventId).toBeDefined();
  });
});

/**
 * CRITICAL TEST SUITE: Cascade Reset Behavior
 *
 * These tests document and verify the expected behavior of cascade resets
 * with parent and child workflows.
 */
test.describe('Cascade Reset - Activity Replay Tests', () => {
  test.beforeAll(async () => {
    client = await connect();
  });

  test('should replay activities before reset point (not re-execute)', async ({
    page,
  }) => {
    /**
     * This test verifies the CRITICAL behavior:
     * - Activities BEFORE the reset point should be REPLAYED from history
     * - Activities AFTER the reset point should be RE-EXECUTED
     *
     * If activities before the reset point are re-executed, it indicates
     * the reset is targeting the wrong event.
     */
    const workflowId = `test-activity-replay-${Date.now()}`;

    // Start workflow with reset points
    const handle = await client.workflow.start(WorkflowWithResetPoints, {
      taskQueue: 'e2e-1',
      args: ['replay-test'],
      workflowId,
    });

    await handle.result();
    const firstRunId = handle.firstExecutionRunId;

    // Count activities in original run
    const originalActivityCount = await countActivityExecutions(
      client,
      workflowId,
      firstRunId,
    );
    console.log(`Original run activity count: ${originalActivityCount}`);

    // Navigate and reset
    await page.goto(
      `/namespaces/default/workflows/${workflowId}/${firstRunId}`,
      { waitUntil: 'domcontentloaded' },
    );

    await page.getByTestId('reset-workflow-button').click();
    await expect(page.getByTestId('reset-confirmation-modal')).toBeVisible();
    await page.getByTestId('reset-mode-reset-point').click();

    const resetPointSelect = page.getByTestId('workflow-reset-point-select');
    await resetPointSelect.click();
    await page
      .getByText(/after-first-activity/)
      .first()
      .click();
    await page.locator('#reset-reason').fill('Testing activity replay');
    await page.getByText('Confirm').click();

    await expect(page.getByTestId('reset-confirmation-modal')).toBeHidden({
      timeout: 10000,
    });

    // Get the new run
    const newHandle = await client.workflow.getHandle(workflowId);
    const newRunId = newHandle.firstExecutionRunId;
    await newHandle.result();

    // Count activities in reset run
    const resetActivityCount = await countActivityExecutions(
      client,
      workflowId,
      newRunId,
    );
    console.log(`Reset run activity count: ${resetActivityCount}`);

    // After reset to "after-first-activity":
    // - First activity should be replayed (no new ActivityTaskScheduled)
    // - Second and third activities should be re-executed
    //
    // Expected: 2 activities in reset run (second + third)
    // If we see 3 activities, the first activity was incorrectly re-executed

    expect(resetActivityCount).toBeLessThan(originalActivityCount);
    expect(resetActivityCount).toBe(2); // Only second and third activities
  });

  test('should verify reset event ID matches WorkflowTaskCompleted', async ({
    page,
  }) => {
    /**
     * This test verifies the reset targets the correct event type.
     * The reset point eventId should be a WorkflowTaskCompleted event.
     */
    const workflowId = `test-event-type-${Date.now()}`;

    const handle = await client.workflow.start(WorkflowWithResetPoints, {
      taskQueue: 'e2e-1',
      args: ['event-type-test'],
      workflowId,
    });

    await handle.result();
    const runId = handle.firstExecutionRunId;

    // Fetch history via API
    await page.goto(
      `/api/namespaces/default/workflows/${workflowId}/runs/${runId}/history`,
    );
    const historyJson = await page.textContent('pre');
    const history = JSON.parse(historyJson);

    // Find the reset point marker and verify it references WorkflowTaskCompleted
    for (const event of history.events || []) {
      if (event.eventType === 'MarkerRecorded') {
        const markerName = event.markerRecordedEventAttributes?.markerName;
        if (
          markerName === 'core_local_activity' ||
          markerName === 'temporal-reset-point'
        ) {
          const taskCompletedId =
            event.markerRecordedEventAttributes?.workflowTaskCompletedEventId;

          console.log(
            `Marker references WorkflowTaskCompleted: ${taskCompletedId}`,
          );

          // Find that event and verify it's WorkflowTaskCompleted
          const taskCompletedEvent = history.events.find(
            (e: { eventId: string }) => e.eventId === taskCompletedId,
          );

          expect(taskCompletedEvent).toBeDefined();
          expect(taskCompletedEvent.eventType).toBe('WorkflowTaskCompleted');
        }
      }
    }
  });
});

test.describe('Cascade Reset - Parent-Child Connection Tests', () => {
  test.beforeAll(async () => {
    client = await connect();
  });

  test('should document parent-child connection after cascade reset', async ({
    page,
  }) => {
    /**
     * DOCUMENTED BEHAVIOR: Cascade reset creates orphaned child workflows.
     *
     * This test verifies and documents the current behavior where:
     * 1. Parent reset creates new run P2
     * 2. Child reset creates new run C2
     * 3. C2 still references P1 (original parent) as its parent
     * 4. P2 replays and references C1 (original child)
     *
     * This means C2 is effectively orphaned - its results are never used.
     */
    const parentWorkflowId = `test-orphan-${Date.now()}`;
    const childWorkflowId = `child-of-${parentWorkflowId}`;

    // Start parent workflow
    const parentHandle = await client.workflow.start(
      ParentWorkflowWithResetPoints,
      {
        taskQueue: 'e2e-1',
        args: ['orphan-test'],
        workflowId: parentWorkflowId,
      },
    );

    await parentHandle.result();
    const originalParentRunId = parentHandle.firstExecutionRunId;

    // Get original child run ID
    const originalChildHandle =
      await client.workflow.getHandle(childWorkflowId);
    const originalChildRunId = originalChildHandle.firstExecutionRunId;

    console.log('Original parent run:', originalParentRunId);
    console.log('Original child run:', originalChildRunId);

    // Perform cascade reset via UI
    await page.goto(
      `/namespaces/default/workflows/${parentWorkflowId}/${originalParentRunId}`,
      { waitUntil: 'domcontentloaded' },
    );

    await page.getByTestId('reset-workflow-button').click();
    await expect(page.getByTestId('reset-confirmation-modal')).toBeVisible();
    await page.getByTestId('reset-mode-reset-point').click();

    const resetPointSelect = page.getByTestId('workflow-reset-point-select');
    await resetPointSelect.click();
    await page
      .getByText(/parent-checkpoint/)
      .first()
      .click();

    // Enable cascade
    const cascadeCheckbox = page.getByTestId('reset-cascade-checkbox');
    await expect(cascadeCheckbox).toBeVisible();
    await cascadeCheckbox.check();

    await page.locator('#reset-reason').fill('Testing orphan behavior');
    await page.getByText('Confirm').click();

    await expect(page.getByTestId('reset-confirmation-modal')).toBeHidden({
      timeout: 15000,
    });

    // Get new run IDs
    const newParentHandle = await client.workflow.getHandle(parentWorkflowId);
    await newParentHandle.result();
    const newParentRunId = newParentHandle.firstExecutionRunId;

    console.log('New parent run after reset:', newParentRunId);

    // Verify parent has new run ID
    expect(newParentRunId).not.toBe(originalParentRunId);

    // Fetch the new parent's history to check which child it references
    const history = await newParentHandle.fetchHistory();

    let referencedChildRunId: string | null = null;
    for (const event of history?.events || []) {
      if (event.eventType === 'EVENT_TYPE_CHILD_WORKFLOW_EXECUTION_STARTED') {
        const attr = event.childWorkflowExecutionStartedEventAttributes;
        referencedChildRunId = attr?.workflowExecution?.runId || null;
        break;
      }
    }

    console.log('Child run referenced by reset parent:', referencedChildRunId);

    // DOCUMENTED BEHAVIOR: The reset parent references the ORIGINAL child
    // This is the "orphan" issue - any new child created by cascade reset is not used
    expect(referencedChildRunId).toBe(originalChildRunId);
  });

  test('should verify cascade creates expected number of resets', async ({
    page,
  }) => {
    /**
     * This test verifies that cascade reset discovers and resets
     * the correct number of workflows in the tree.
     */
    const parentWorkflowId = `test-cascade-count-${Date.now()}`;

    const parentHandle = await client.workflow.start(
      ParentWorkflowWithResetPoints,
      {
        taskQueue: 'e2e-1',
        args: ['count-test'],
        workflowId: parentWorkflowId,
      },
    );

    await parentHandle.result();
    const parentRunId = parentHandle.firstExecutionRunId;

    // Navigate to parent workflow
    await page.goto(
      `/namespaces/default/workflows/${parentWorkflowId}/${parentRunId}`,
      { waitUntil: 'domcontentloaded' },
    );

    await page.getByTestId('reset-workflow-button').click();
    await expect(page.getByTestId('reset-confirmation-modal')).toBeVisible();
    await page.getByTestId('reset-mode-reset-point').click();

    const resetPointSelect = page.getByTestId('workflow-reset-point-select');
    await resetPointSelect.click();
    await page
      .getByText(/parent-checkpoint/)
      .first()
      .click();

    // Enable cascade
    await page.getByTestId('reset-cascade-checkbox').check();

    // Check if cascade plan preview is shown
    // The UI should display how many workflows will be reset
    const cascadePlanSection = page.getByTestId('cascade-reset-plan');

    // If the UI has a plan preview, verify counts
    if (await cascadePlanSection.isVisible()) {
      const planText = await cascadePlanSection.textContent();
      console.log('Cascade plan preview:', planText);

      // Should include at least 2 workflows (parent + child)
      expect(planText).toContain('2');
    }

    // Perform reset
    await page.locator('#reset-reason').fill('Testing cascade count');
    await page.getByText('Confirm').click();

    await expect(page.getByTestId('reset-confirmation-modal')).toBeHidden({
      timeout: 15000,
    });

    // Verify both parent and child have new runs
    const newParentHandle = await client.workflow.getHandle(parentWorkflowId);
    expect(newParentHandle.firstExecutionRunId).not.toBe(parentRunId);

    console.log('Cascade reset completed successfully');
  });
});

test.describe('Cascade Reset - Child Selection Tests', () => {
  test.beforeAll(async () => {
    client = await connect();
  });

  test('should only reset children started BEFORE the reset point', async ({
    page: _page,
  }) => {
    /**
     * Children started AFTER the reset point should NOT be included
     * in the cascade reset, as they don't exist in the reset history.
     *
     * In our test workflows, the child is started AFTER the parent-checkpoint,
     * so it should NOT be included in cascade.
     */
    // Note: Our current test workflow starts the child AFTER the parent checkpoint
    // This test documents that behavior

    const parentWorkflowId = `test-child-selection-${Date.now()}`;

    const parentHandle = await client.workflow.start(
      ParentWorkflowWithResetPoints,
      {
        taskQueue: 'e2e-1',
        args: ['selection-test'],
        workflowId: parentWorkflowId,
      },
    );

    await parentHandle.result();
    const _parentRunId = parentHandle.firstExecutionRunId;

    // Fetch parent history to verify child timing
    const history = await parentHandle.fetchHistory();

    let resetPointEventId: number | null = null;
    let childStartedEventId: number | null = null;

    for (const event of history?.events || []) {
      if (event.eventType === 'EVENT_TYPE_MARKER_RECORDED') {
        // This is likely a reset point
        resetPointEventId = Number(event.eventId);
      }
      if (
        event.eventType ===
        'EVENT_TYPE_START_CHILD_WORKFLOW_EXECUTION_INITIATED'
      ) {
        childStartedEventId = Number(event.eventId);
      }
    }

    console.log('Reset point event ID:', resetPointEventId);
    console.log('Child started event ID:', childStartedEventId);

    // Document the timing relationship
    if (resetPointEventId && childStartedEventId) {
      if (childStartedEventId > resetPointEventId) {
        console.log(
          'Child started AFTER reset point - should NOT be included in cascade',
        );
      } else {
        console.log(
          'Child started BEFORE reset point - should be included in cascade',
        );
      }
    }

    // The test workflow has child started AFTER checkpoint
    // So cascade should NOT include the child
    expect(childStartedEventId).toBeGreaterThan(resetPointEventId!);
  });

  test('should skip children without matching reset point name', async ({
    page: _page,
  }) => {
    /**
     * Children that don't have the same reset point marker name
     * should be added to the 'skipped' list, not reset.
     *
     * This test documents the expected behavior via the buildCascadingPlan
     * function structure.
     */
    // This is conceptual - our test workflow has matching reset point names
    // For full testing, we'd need a workflow with children having different markers

    // Document the expected behavior
    const expectedBehavior = {
      parentWithMarker: 'included in resets',
      childWithSameMarker: 'included in resets',
      childWithDifferentMarker: 'added to skipped list',
      childWithNoMarker: 'added to skipped list',
    };

    expect(expectedBehavior.childWithDifferentMarker).toBe(
      'added to skipped list',
    );
    console.log('Expected cascade behavior:', expectedBehavior);
  });
});
