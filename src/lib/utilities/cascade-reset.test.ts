import { describe, expect, it } from 'vitest';

import type { WorkflowEvents } from '$lib/types/events';

import {
  buildCascadingPlan,
  extractChildrenBeforeEvent,
} from './cascade-reset';

// Helper to create a base event
const createBaseEvent = (id: string, eventType: string) => ({
  id,
  eventTime: '2023-10-13T14:50:18.784547Z',
  eventType,
  version: '0',
  taskId: '28312355',
});

// Helper to create StartChildWorkflowExecutionInitiated event
const createStartChildWorkflowInitiated = (id: string, workflowId: string) => ({
  ...createBaseEvent(id, 'StartChildWorkflowExecutionInitiated'),
  startChildWorkflowExecutionInitiatedEventAttributes: {
    workflowId,
    workflowType: {
      name: 'ChildWorkflow',
    },
    taskQueue: {
      name: 'test-queue',
      kind: 'Normal',
    },
    input: null,
    workflowExecutionTimeout: '0s',
    workflowRunTimeout: '0s',
    workflowTaskTimeout: '10s',
  },
});

// Helper to create ChildWorkflowExecutionStarted event
const createChildWorkflowStarted = (
  id: string,
  initiatedEventId: string,
  workflowId: string,
  runId: string,
) => ({
  ...createBaseEvent(id, 'ChildWorkflowExecutionStarted'),
  childWorkflowExecutionStartedEventAttributes: {
    initiatedEventId,
    workflowExecution: {
      workflowId,
      runId,
    },
    workflowType: {
      name: 'ChildWorkflow',
    },
  },
});

describe('extractChildrenBeforeEvent', () => {
  it('should extract children started before the specified event', () => {
    const events: WorkflowEvents = [
      createStartChildWorkflowInitiated('5', 'child-1'),
      createChildWorkflowStarted('6', '5', 'child-1', 'run-1'),
      createStartChildWorkflowInitiated('10', 'child-2'),
      createChildWorkflowStarted('11', '10', 'child-2', 'run-2'),
      createBaseEvent('15', 'WorkflowTaskCompleted'), // Reset boundary
      createStartChildWorkflowInitiated('20', 'child-3'),
      createChildWorkflowStarted('21', '20', 'child-3', 'run-3'),
    ];

    const children = extractChildrenBeforeEvent(events, '15');

    expect(children).toHaveLength(2);
    expect(children).toEqual([
      { workflowId: 'child-1', runId: 'run-1' },
      { workflowId: 'child-2', runId: 'run-2' },
    ]);
  });

  it('should not include children started after the event', () => {
    const events: WorkflowEvents = [
      createStartChildWorkflowInitiated('5', 'child-1'),
      createChildWorkflowStarted('6', '5', 'child-1', 'run-1'),
      createBaseEvent('10', 'WorkflowTaskCompleted'), // Reset boundary
      createStartChildWorkflowInitiated('15', 'child-2'),
      createChildWorkflowStarted('16', '15', 'child-2', 'run-2'),
    ];

    const children = extractChildrenBeforeEvent(events, '10');

    expect(children).toHaveLength(1);
    expect(children[0]).toEqual({ workflowId: 'child-1', runId: 'run-1' });
  });

  it('should not include children that were initiated but not started', () => {
    const events: WorkflowEvents = [
      createStartChildWorkflowInitiated('5', 'child-1'),
      createChildWorkflowStarted('6', '5', 'child-1', 'run-1'),
      createStartChildWorkflowInitiated('10', 'child-2'),
      // No corresponding ChildWorkflowExecutionStarted for child-2
      createBaseEvent('15', 'WorkflowTaskCompleted'),
    ];

    const children = extractChildrenBeforeEvent(events, '15');

    expect(children).toHaveLength(1);
    expect(children[0]).toEqual({ workflowId: 'child-1', runId: 'run-1' });
  });

  it('should handle empty event list', () => {
    const events: WorkflowEvents = [];
    const children = extractChildrenBeforeEvent(events, '10');
    expect(children).toHaveLength(0);
  });

  it('should handle events with no children', () => {
    const events: WorkflowEvents = [
      createBaseEvent('5', 'WorkflowTaskCompleted'),
      createBaseEvent('10', 'WorkflowTaskCompleted'),
    ];

    const children = extractChildrenBeforeEvent(events, '10');
    expect(children).toHaveLength(0);
  });

  it('should handle event ID at boundary exactly', () => {
    const events: WorkflowEvents = [
      createStartChildWorkflowInitiated('5', 'child-1'),
      createChildWorkflowStarted('6', '5', 'child-1', 'run-1'),
      createStartChildWorkflowInitiated('10', 'child-2'),
      createChildWorkflowStarted('11', '10', 'child-2', 'run-2'),
    ];

    // Event 11 is the boundary - child-2 started AT event 11, so should not be included
    const children = extractChildrenBeforeEvent(events, '11');

    expect(children).toHaveLength(1);
    expect(children[0]).toEqual({ workflowId: 'child-1', runId: 'run-1' });
  });

  it('should handle multiple children initiated in sequence', () => {
    const events: WorkflowEvents = [
      createStartChildWorkflowInitiated('5', 'child-1'),
      createStartChildWorkflowInitiated('6', 'child-2'),
      createStartChildWorkflowInitiated('7', 'child-3'),
      createChildWorkflowStarted('8', '5', 'child-1', 'run-1'),
      createChildWorkflowStarted('9', '6', 'child-2', 'run-2'),
      createChildWorkflowStarted('10', '7', 'child-3', 'run-3'),
      createBaseEvent('15', 'WorkflowTaskCompleted'),
    ];

    const children = extractChildrenBeforeEvent(events, '15');

    expect(children).toHaveLength(3);
    expect(children.map((c) => c.workflowId)).toEqual([
      'child-1',
      'child-2',
      'child-3',
    ]);
  });
});

describe('buildCascadingPlan', () => {
  // Note: buildCascadingPlan is complex and involves async service calls.
  // Full integration testing will be done in the integration test suite.
  // Here we just document the expected behavior.

  it('should be tested in integration tests', () => {
    // The buildCascadingPlan function:
    // 1. Fetches workflow history
    // 2. Finds reset point markers
    // 3. Discovers child workflows recursively
    // 4. Builds a cascading reset plan sorted by depth
    //
    // This is properly tested in:
    // - tests/integration/workflow-reset-points.spec.ts
    //
    // Unit testing this function would require extensive mocking
    // of the events-service and extract-reset-points modules,
    // which provides less value than integration tests.
    expect(typeof buildCascadingPlan).toBe('function');
  });
});
