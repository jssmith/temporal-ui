/* eslint-disable import/order */
import * as workflow from '@temporalio/workflow';
import type * as activities from './activities';
/* eslint-enable import/order */

const { echo: Activity } = workflow.proxyActivities<typeof activities>({
  startToCloseTimeout: '10 seconds',
});

const { echo: LocalActivity } = workflow.proxyLocalActivities<
  typeof activities
>({
  startToCloseTimeout: '10 seconds',
});

const isBlockedQuery = workflow.defineQuery<boolean>('is-blocked');
const unblockSignal = workflow.defineSignal('unblock');

const { double } = workflow.proxyActivities<typeof activities>({
  startToCloseTimeout: '1 hour',
  retry: {
    maximumAttempts: 1,
  },
});

export async function Workflow(input: string): Promise<string> {
  let result: string;

  result = await LocalActivity(input);
  result = await Activity(input);

  return result;
}

export async function BlockingWorkflow(input: string): Promise<string> {
  let isBlocked = true;

  workflow.setHandler(unblockSignal, () => void (isBlocked = false));
  workflow.setHandler(isBlockedQuery, () => isBlocked);

  try {
    await workflow.condition(() => !isBlocked);
  } catch (err) {
    if (err instanceof workflow.CancelledFailure) {
      console.log('Cancelled');
    }
    throw err;
  }

  return Activity(input);
}

export async function CompletedWorkflow(
  amount: number,
  iterations = 0,
): Promise<number> {
  if (iterations) {
    await workflow.continueAsNew(amount, iterations - 1);
  }

  return await double(amount);
}

export async function RunningWorkflow(): Promise<void> {
  return await workflow.sleep('10 days');
}

// Import reset point helper
import { recordResetPoint } from './reset-point-helper';

/**
 * Test workflow with reset points for integration testing.
 * This workflow executes multiple activities and records reset points between them.
 */
export async function WorkflowWithResetPoints(input: string): Promise<string> {
  let result = `start-${input}`;

  // Step 1: Execute first activity
  result = await Activity(result);

  // Record reset point after first activity
  await recordResetPoint('after-first-activity');

  // Step 2: Execute second activity
  result = await Activity(result);

  // Record reset point after second activity
  await recordResetPoint('after-second-activity');

  // Step 3: Execute third activity
  result = await Activity(result);

  return result;
}

/**
 * Parent workflow that spawns a child workflow for cascading reset tests.
 */
export async function ParentWorkflowWithResetPoints(
  input: string,
): Promise<string> {
  let result = `parent-start-${input}`;

  // Step 1: Execute parent activity
  result = await Activity(result);

  // Record reset point after parent activity
  await recordResetPoint('parent-checkpoint');

  // Step 2: Start child workflow
  const childHandle = await workflow.startChild(ChildWorkflowWithResetPoints, {
    args: [input],
    workflowId: `child-of-${workflow.workflowInfo().workflowId}`,
  });

  const childResult = await childHandle.result();
  result = `${result}-${childResult}`;

  // Step 3: Execute another parent activity
  result = await Activity(result);

  return result;
}

/**
 * Child workflow with reset points for cascading reset tests.
 */
export async function ChildWorkflowWithResetPoints(
  input: string,
): Promise<string> {
  let result = `child-start-${input}`;

  // Step 1: Execute child activity
  result = await Activity(result);

  // Record reset point in child (same name as parent for cascading)
  await recordResetPoint('parent-checkpoint');

  // Step 2: Execute another child activity
  result = await Activity(result);

  return result;
}

/**
 * Parent workflow WITHOUT markers - for testing propagate-up feature.
 * The markers exist only in the child workflow.
 */
export async function ParentWithoutMarkers(input: string): Promise<string> {
  let result = `parent-no-markers-${input}`;

  // Step 1: Execute parent activity (no marker after this)
  result = await Activity(result);

  // Step 2: Start child workflow that HAS markers
  const childHandle = await workflow.startChild(ChildWithMarkersOnly, {
    args: [input],
    workflowId: `child-markers-${workflow.workflowInfo().workflowId}`,
  });

  const childResult = await childHandle.result();
  result = `${result}-${childResult}`;

  // Step 3: Execute another parent activity (still no marker)
  result = await Activity(result);

  return result;
}

/**
 * Child workflow that has markers (for propagate-up testing).
 * Parent workflow has NO markers, so cascade must propagate up.
 */
export async function ChildWithMarkersOnly(input: string): Promise<string> {
  let result = `child-with-markers-${input}`;

  // Step 1: Execute child activity
  result = await Activity(result);

  // Record reset point - this is the only marker in the tree!
  await recordResetPoint('child-only-checkpoint');

  // Step 2: Execute another child activity
  result = await Activity(result);

  return result;
}

/**
 * Grandparent workflow for testing multi-level propagate-up.
 * Grandparent → Parent (no markers) → Child (has markers)
 */
export async function GrandparentWithoutMarkers(
  input: string,
): Promise<string> {
  let result = `grandparent-${input}`;

  // Execute grandparent activity
  result = await Activity(result);

  // Start parent without markers (which will start child with markers)
  const parentHandle = await workflow.startChild(ParentWithoutMarkers, {
    args: [input],
    workflowId: `parent-of-${workflow.workflowInfo().workflowId}`,
  });

  const parentResult = await parentHandle.result();
  result = `${result}-${parentResult}`;

  return result;
}
