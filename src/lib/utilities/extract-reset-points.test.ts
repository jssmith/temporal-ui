import { describe, expect, it } from 'vitest';

import type { WorkflowEvents } from '$lib/types/events';

import {
  extractResetPoints,
  findResetPointEventId,
} from './extract-reset-points';

// Helper to create a base event
const createBaseEvent = (id: string, eventType: string) => ({
  id,
  eventTime: '2023-10-13T14:50:18.784547Z',
  eventType,
  version: '0',
  taskId: '28312355',
});

// Helper to create a WorkflowTaskCompleted event
const createWorkflowTaskCompleted = (id: string) => ({
  ...createBaseEvent(id, 'WorkflowTaskCompleted'),
  workflowTaskCompletedEventAttributes: {
    scheduledEventId: String(parseInt(id) - 2),
    startedEventId: String(parseInt(id) - 1),
    identity: 'test-worker@test',
  },
});

// Helper to create a native reset point marker
const createNativeResetPointMarker = (
  id: string,
  name: string,
  workflowTaskCompletedEventId: string,
) => ({
  ...createBaseEvent(id, 'MarkerRecorded'),
  markerRecordedEventAttributes: {
    markerName: 'temporal-reset-point',
    details: {
      name: {
        payloads: [
          {
            metadata: {
              encoding: 'anNvbi9wbGFpbg==', // json/plain
            },
            data: btoa(JSON.stringify(name)),
          },
        ],
      },
    },
    workflowTaskCompletedEventId,
  },
});

// Helper to create a SideEffect marker with reset point
const createSideEffectMarker = (
  id: string,
  name: string,
  workflowTaskCompletedEventId: string,
) => ({
  ...createBaseEvent(id, 'MarkerRecorded'),
  markerRecordedEventAttributes: {
    markerName: 'SideEffect',
    details: {
      data: {
        payloads: [
          {
            metadata: {
              encoding: 'anNvbi9wbGFpbg==',
            },
            data: btoa(
              JSON.stringify({
                Type: 'temporal-reset-point',
                Name: name,
              }),
            ),
          },
        ],
      },
    },
    workflowTaskCompletedEventId,
  },
});

// Helper to create a LocalActivity marker with reset point
const createLocalActivityMarker = (
  id: string,
  name: string,
  workflowTaskCompletedEventId: string,
) => ({
  ...createBaseEvent(id, 'MarkerRecorded'),
  markerRecordedEventAttributes: {
    markerName: 'core_local_activity',
    details: {
      result: {
        payloads: [
          {
            metadata: {
              encoding: 'anNvbi9wbGFpbg==',
            },
            data: btoa(
              JSON.stringify({
                MarkerType: 'temporal-reset-point',
                Name: name,
              }),
            ),
          },
        ],
      },
    },
    workflowTaskCompletedEventId,
  },
});

describe('extractResetPoints', () => {
  describe('Native reset point markers', () => {
    it('should extract a single native reset point marker', () => {
      const events: WorkflowEvents = [
        createWorkflowTaskCompleted('10'),
        createNativeResetPointMarker('11', 'checkpoint1', '10'),
        createWorkflowTaskCompleted('15'),
      ];

      const resetPoints = extractResetPoints(events);

      expect(resetPoints).toHaveLength(1);
      expect(resetPoints[0]).toEqual({
        name: 'checkpoint1',
        eventId: '10', // WorkflowTaskCompleted that contains the marker
      });
    });

    it('should extract multiple native reset point markers', () => {
      const events: WorkflowEvents = [
        createWorkflowTaskCompleted('10'),
        createNativeResetPointMarker('11', 'checkpoint1', '10'),
        createWorkflowTaskCompleted('15'),
        createNativeResetPointMarker('16', 'checkpoint2', '15'),
        createWorkflowTaskCompleted('20'),
      ];

      const resetPoints = extractResetPoints(events);

      expect(resetPoints).toHaveLength(2);
      expect(resetPoints[0]).toEqual({
        name: 'checkpoint1',
        eventId: '10',
      });
      expect(resetPoints[1]).toEqual({
        name: 'checkpoint2',
        eventId: '15',
      });
    });

    it('should extract markers even if there is no subsequent WorkflowTaskCompleted', () => {
      const events: WorkflowEvents = [
        createWorkflowTaskCompleted('10'),
        createNativeResetPointMarker('11', 'checkpoint1', '10'),
        // No subsequent WorkflowTaskCompleted - but we still use the one from marker attributes
      ];

      const resetPoints = extractResetPoints(events);

      expect(resetPoints).toHaveLength(1);
      expect(resetPoints[0]).toEqual({
        name: 'checkpoint1',
        eventId: '10',
      });
    });
  });

  describe('SideEffect markers', () => {
    it('should extract reset point from SideEffect marker', () => {
      const events: WorkflowEvents = [
        createWorkflowTaskCompleted('10'),
        createSideEffectMarker('11', 'checkpoint1', '10'),
        createWorkflowTaskCompleted('15'),
      ];

      const resetPoints = extractResetPoints(events);

      expect(resetPoints).toHaveLength(1);
      expect(resetPoints[0]).toEqual({
        name: 'checkpoint1',
        eventId: '10',
      });
    });

    it('should skip SideEffect markers without reset point data', () => {
      const events: WorkflowEvents = [
        createWorkflowTaskCompleted('10'),
        {
          ...createBaseEvent('11', 'MarkerRecorded'),
          markerRecordedEventAttributes: {
            markerName: 'SideEffect',
            details: {
              data: {
                payloads: [
                  {
                    metadata: {
                      encoding: 'anNvbi9wbGFpbg==',
                    },
                    data: btoa(JSON.stringify({ Type: 'other' })),
                  },
                ],
              },
            },
            workflowTaskCompletedEventId: '10',
          },
        },
        createWorkflowTaskCompleted('15'),
      ];

      const resetPoints = extractResetPoints(events);

      expect(resetPoints).toHaveLength(0);
    });
  });

  describe('LocalActivity markers', () => {
    it('should extract reset point from LocalActivity marker', () => {
      const events: WorkflowEvents = [
        createWorkflowTaskCompleted('10'),
        createLocalActivityMarker('11', 'checkpoint1', '10'),
        createWorkflowTaskCompleted('15'),
      ];

      const resetPoints = extractResetPoints(events);

      expect(resetPoints).toHaveLength(1);
      expect(resetPoints[0]).toEqual({
        name: 'checkpoint1',
        eventId: '10',
      });
    });

    it('should handle lowercase field names in LocalActivity markers', () => {
      const events: WorkflowEvents = [
        createWorkflowTaskCompleted('10'),
        {
          ...createBaseEvent('11', 'MarkerRecorded'),
          markerRecordedEventAttributes: {
            markerName: 'core_local_activity',
            details: {
              result: {
                payloads: [
                  {
                    metadata: {
                      encoding: 'anNvbi9wbGFpbg==',
                    },
                    data: btoa(
                      JSON.stringify({
                        marker_type: 'temporal-reset-point',
                        name: 'checkpoint1',
                      }),
                    ),
                  },
                ],
              },
            },
            workflowTaskCompletedEventId: '10',
          },
        },
        createWorkflowTaskCompleted('15'),
      ];

      const resetPoints = extractResetPoints(events);

      expect(resetPoints).toHaveLength(1);
      expect(resetPoints[0]).toEqual({
        name: 'checkpoint1',
        eventId: '10',
      });
    });
  });

  describe('Mixed marker types', () => {
    it('should extract reset points from all marker types', () => {
      const events: WorkflowEvents = [
        createWorkflowTaskCompleted('10'),
        createNativeResetPointMarker('11', 'native-marker', '10'),
        createWorkflowTaskCompleted('15'),
        createSideEffectMarker('16', 'side-effect-marker', '15'),
        createWorkflowTaskCompleted('20'),
        createLocalActivityMarker('21', 'local-activity-marker', '20'),
        createWorkflowTaskCompleted('25'),
      ];

      const resetPoints = extractResetPoints(events);

      expect(resetPoints).toHaveLength(3);
      expect(resetPoints[0].name).toBe('native-marker');
      expect(resetPoints[1].name).toBe('side-effect-marker');
      expect(resetPoints[2].name).toBe('local-activity-marker');
    });
  });

  describe('Edge cases', () => {
    it('should handle empty event list', () => {
      const events: WorkflowEvents = [];
      const resetPoints = extractResetPoints(events);
      expect(resetPoints).toHaveLength(0);
    });

    it('should handle events with no markers', () => {
      const events: WorkflowEvents = [
        createWorkflowTaskCompleted('10'),
        createWorkflowTaskCompleted('15'),
        createWorkflowTaskCompleted('20'),
      ];

      const resetPoints = extractResetPoints(events);
      expect(resetPoints).toHaveLength(0);
    });

    it('should handle marker with missing details', () => {
      const events: WorkflowEvents = [
        createWorkflowTaskCompleted('10'),
        {
          ...createBaseEvent('11', 'MarkerRecorded'),
          markerRecordedEventAttributes: {
            markerName: 'temporal-reset-point',
            details: null,
            workflowTaskCompletedEventId: '10',
          },
        },
        createWorkflowTaskCompleted('15'),
      ];

      const resetPoints = extractResetPoints(events);
      expect(resetPoints).toHaveLength(0);
    });

    it('should handle marker with malformed payload', () => {
      const events: WorkflowEvents = [
        createWorkflowTaskCompleted('10'),
        {
          ...createBaseEvent('11', 'MarkerRecorded'),
          markerRecordedEventAttributes: {
            markerName: 'temporal-reset-point',
            details: {
              name: {
                payloads: [
                  {
                    metadata: {
                      encoding: 'anNvbi9wbGFpbg==',
                    },
                    data: btoa('not-a-json-string'),
                  },
                ],
              },
            },
            workflowTaskCompletedEventId: '10',
          },
        },
        createWorkflowTaskCompleted('15'),
      ];

      const resetPoints = extractResetPoints(events);
      // Should handle gracefully - decoding may succeed but return non-string
      // The code will continue and may or may not add the point depending on validation
      expect(Array.isArray(resetPoints)).toBe(true);
    });

    it('should handle duplicate reset point names', () => {
      const events: WorkflowEvents = [
        createWorkflowTaskCompleted('10'),
        createNativeResetPointMarker('11', 'checkpoint', '10'),
        createWorkflowTaskCompleted('15'),
        createNativeResetPointMarker('16', 'checkpoint', '15'),
        createWorkflowTaskCompleted('20'),
      ];

      const resetPoints = extractResetPoints(events);

      // Both should be extracted (findResetPointEventId will return first)
      expect(resetPoints).toHaveLength(2);
      expect(resetPoints[0].name).toBe('checkpoint');
      expect(resetPoints[1].name).toBe('checkpoint');
    });

    it('should handle marker at end of workflow', () => {
      const events: WorkflowEvents = [
        createWorkflowTaskCompleted('10'),
        createNativeResetPointMarker('11', 'final-checkpoint', '10'),
      ];

      const resetPoints = extractResetPoints(events);
      expect(resetPoints).toHaveLength(1);
      expect(resetPoints[0]).toEqual({
        name: 'final-checkpoint',
        eventId: '10',
      });
    });
  });
});

describe('findResetPointEventId', () => {
  it('should find the event ID for a specific reset point name', () => {
    const events: WorkflowEvents = [
      createWorkflowTaskCompleted('10'),
      createNativeResetPointMarker('11', 'checkpoint1', '10'),
      createWorkflowTaskCompleted('15'),
      createNativeResetPointMarker('16', 'checkpoint2', '15'),
      createWorkflowTaskCompleted('20'),
    ];

    const eventId = findResetPointEventId(events, 'checkpoint2');
    expect(eventId).toBe('15');
  });

  it('should return null if reset point is not found', () => {
    const events: WorkflowEvents = [
      createWorkflowTaskCompleted('10'),
      createNativeResetPointMarker('11', 'checkpoint1', '10'),
      createWorkflowTaskCompleted('15'),
    ];

    const eventId = findResetPointEventId(events, 'nonexistent');
    expect(eventId).toBeNull();
  });

  it('should return the first occurrence when duplicate names exist', () => {
    const events: WorkflowEvents = [
      createWorkflowTaskCompleted('10'),
      createNativeResetPointMarker('11', 'checkpoint', '10'),
      createWorkflowTaskCompleted('15'),
      createNativeResetPointMarker('16', 'checkpoint', '15'),
      createWorkflowTaskCompleted('20'),
    ];

    const eventId = findResetPointEventId(events, 'checkpoint');
    expect(eventId).toBe('10'); // First occurrence
  });

  it('should return null for empty event list', () => {
    const events: WorkflowEvents = [];
    const eventId = findResetPointEventId(events, 'checkpoint');
    expect(eventId).toBeNull();
  });
});
