<script lang="ts">
  import { writable, type Writable } from 'svelte/store';

  import Checkbox from '$lib/holocene/checkbox.svelte';
  import Spinner from '$lib/holocene/icon/svg/spinner.svelte';
  import Input from '$lib/holocene/input/input.svelte';
  import Modal from '$lib/holocene/modal.svelte';
  import RadioGroup from '$lib/holocene/radio-input/radio-group.svelte';
  import RadioInput from '$lib/holocene/radio-input/radio-input.svelte';
  import Option from '$lib/holocene/select/option.svelte';
  import Select from '$lib/holocene/select/select.svelte';
  import { translate } from '$lib/i18n/translate';
  import {
    cascadeResetWorkflow,
    resetWorkflow,
    resetWorkflowByPoint,
  } from '$lib/services/workflow-service';
  import { isCloud } from '$lib/stores/advanced-visibility';
  import { resetEvents } from '$lib/stores/events';
  import { resetPoints } from '$lib/stores/reset-points';
  import { resetWorkflows } from '$lib/stores/reset-workflows';
  import { temporalVersion } from '$lib/stores/versions';
  import type { WorkflowExecution } from '$lib/types/workflows';
  import {
    discoverAllResetPoints,
    type DiscoveredResetPoint,
  } from '$lib/utilities/cascade-reset';
  import { getIdentity } from '$lib/utilities/core-context';
  import { isNetworkError } from '$lib/utilities/is-network-error';
  import { minimumVersionRequired } from '$lib/utilities/version-check';

  export let open: boolean;
  export let workflow: WorkflowExecution;
  export let namespace: string;
  export let refresh: Writable<number>;
  export let presetEventId: string = '';
  export let onResetCompletion: ({
    runId,
  }: {
    runId: string;
  }) => void = () => {};

  let error = '';
  let loading = false;
  let eventId: Writable<string> = writable(presetEventId);
  let reason: string;
  let includeSignals = true;
  let excludeSignals = false;

  let overrideBehavior = 'unspecified';
  let deploymentName = '';
  let buildId = '';

  let excludeUpdates = false;

  // Reset point options
  type ResetMode = 'event-id' | 'reset-point';
  let resetMode: Writable<ResetMode> = writable('event-id');
  let selectedResetPoint: Writable<string> = writable('');
  let cascade = false;
  let cascadeProgress = '';

  // Discovered reset points (includes child markers when cascade is enabled)
  let discoveredResetPoints: DiscoveredResetPoint[] = [];
  let discoveringResetPoints = false;

  const identity = getIdentity();

  // Handle cascade checkbox change - discover child markers when enabled
  async function onCascadeChange(checked: boolean) {
    cascade = checked;
    $selectedResetPoint = '';

    if (checked) {
      discoveringResetPoints = true;
      try {
        discoveredResetPoints = await discoverAllResetPoints(
          namespace,
          workflow.id,
          workflow.runId,
        );
      } catch (err) {
        console.error('Failed to discover reset points:', err);
        discoveredResetPoints = [];
      } finally {
        discoveringResetPoints = false;
      }
    } else {
      discoveredResetPoints = [];
    }
  }

  // Get combined reset points for dropdown
  $: availableResetPoints = cascade
    ? discoveredResetPoints
    : $resetPoints.map((rp) => ({
        name: rp.name,
        displayName: rp.name,
        source: 'parent' as const,
      }));

  // Check if any reset points are available (including discovered child points)
  $: _hasAnyResetPoints = cascade
    ? discoveredResetPoints.length > 0
    : $resetPoints.length > 0;

  const hideResetModal = () => {
    open = false;
    includeSignals = true;
    excludeSignals = false;
    excludeUpdates = false;
    $eventId = '';
    $selectedResetPoint = '';
    $resetMode = 'event-id';
    cascade = false;
    cascadeProgress = '';
    discoveredResetPoints = [];
    discoveringResetPoints = false;
    reason = '';
    error = '';
  };

  const reset = async () => {
    error = '';
    loading = true;
    cascadeProgress = '';

    try {
      // Handle reset by point with cascade
      if ($resetMode === 'reset-point' && cascade) {
        const result = await cascadeResetWorkflow({
          namespace,
          workflow,
          resetPointName: $selectedResetPoint,
          reason,
          includeSignals,
          excludeSignals,
          excludeUpdates,
          identity,
        });

        cascadeProgress = translate('workflows.cascade-reset-complete', {
          success: result.successCount,
          total: result.totalCount,
        });

        if (result.skipped.length > 0) {
          cascadeProgress +=
            '\n' +
            translate('workflows.cascade-reset-skipped', {
              count: result.skipped.length,
            });
        }

        // Get the parent workflow's new run ID (depth 0)
        const parentResult = result.results.find((r) => r.depth === 0);
        if (parentResult) {
          resetWorkflows.update((previous) => ({
            ...previous,
            [workflow.runId]: parentResult.runId,
          }));

          if (onResetCompletion) {
            onResetCompletion({ runId: parentResult.runId });
          }
        }

        $refresh = Date.now();

        // Show success message briefly before closing
        setTimeout(() => {
          hideResetModal();
        }, 2000);
        return;
      }

      // Handle reset by point (simple)
      if ($resetMode === 'reset-point') {
        const response = await resetWorkflowByPoint({
          namespace,
          workflow,
          resetPointName: $selectedResetPoint,
          reason,
          includeSignals,
          excludeSignals,
          excludeUpdates,
          identity,
        });

        if (onResetCompletion) {
          onResetCompletion(response);
        }

        if (response && response.runId) {
          resetWorkflows.update((previous) => ({
            ...previous,
            [workflow.runId]: response.runId,
          }));
        }
        $refresh = Date.now();
        hideResetModal();
        return;
      }

      // Handle reset by event ID (existing behavior)
      const response = await resetWorkflow({
        namespace,
        workflow,
        eventId: $eventId,
        reason,
        includeSignals,
        excludeSignals,
        excludeUpdates,
        identity,
      });

      if (onResetCompletion) {
        onResetCompletion(response);
      }

      if (response && response.runId) {
        resetWorkflows.update((previous) => ({
          ...previous,
          [workflow.runId]: response.runId,
        }));
      }
      $refresh = Date.now();
      hideResetModal();
    } catch (err) {
      console.error('Reset workflow error:', err);
      error = isNetworkError(err)
        ? err.message
        : err?.message || translate('common.unknown-error');
    } finally {
      loading = false;
    }
  };

  // Computed property for confirm button disabled state
  $: confirmDisabled =
    ($resetMode === 'event-id' && !$eventId) ||
    ($resetMode === 'reset-point' && !$selectedResetPoint) ||
    discoveringResetPoints;
</script>

<Modal
  id="reset-confirmation-modal"
  data-testid="reset-confirmation-modal"
  confirmText={translate('common.confirm')}
  cancelText={translate('common.cancel')}
  bind:error
  bind:open
  {loading}
  on:confirmModal={reset}
  on:cancelModal={hideResetModal}
  {confirmDisabled}
>
  <h3 slot="title">{translate('workflows.reset-modal-title')}</h3>
  <svelte:fragment slot="content">
    <div class="flex w-full flex-col gap-4">
      <!-- Radio group to choose between Event ID and Reset Point -->
      <RadioGroup
        description={translate('workflows.reset-event-radio-group-description')}
        bind:group={resetMode}
        name="reset-mode"
      >
        <RadioInput
          id="reset-mode-event-id"
          value="event-id"
          label={translate('workflows.reset-by-event-id')}
        />
        <RadioInput
          id="reset-mode-reset-point"
          value="reset-point"
          label={translate('workflows.reset-by-reset-point')}
        />
      </RadioGroup>

      <!-- Event ID Select (shown when resetMode is 'event-id') -->
      {#if $resetMode === 'event-id'}
        <Select
          data-testid="workflow-reset-event-id-select"
          menuClass="max-h-[16rem]"
          label={translate('workflows.reset-by-event-id')}
          bind:value={$eventId}
          id="reset-event-id"
        >
          {#each $resetEvents as event}
            <Option value={event.id}>{event.id} - {event.eventType}</Option>
          {/each}
        </Select>
      {/if}

      <!-- Reset Point Select (shown when resetMode is 'reset-point') -->
      {#if $resetMode === 'reset-point'}
        <!-- Cascade checkbox (shown first to discover child markers) -->
        <Checkbox
          id="reset-cascade-checkbox"
          data-testid="reset-cascade-checkbox"
          checked={cascade}
          on:change={(e) => onCascadeChange(e.detail.checked)}
          label={translate('workflows.cascade-to-children')}
        />

        <!-- Loading indicator when discovering child markers -->
        {#if discoveringResetPoints}
          <div class="text-gray-600 flex items-center gap-2 text-sm">
            <Spinner />
            <span>{translate('workflows.discovering-reset-points')}</span>
          </div>
        {:else}
          <Select
            data-testid="workflow-reset-point-select"
            menuClass="max-h-[16rem]"
            label={translate('workflows.reset-point-select-label')}
            bind:value={$selectedResetPoint}
            id="reset-point"
          >
            {#if availableResetPoints.length === 0}
              <Option value="" disabled>
                {translate('workflows.reset-no-points-available')}
              </Option>
            {:else}
              {#each availableResetPoints as resetPoint}
                <Option value={resetPoint.name}>
                  {resetPoint.displayName}
                  {#if resetPoint.source === 'child' && (resetPoint.childWorkflowIds?.length ?? 0) > 1}
                    <span class="text-gray-500"
                      >(children: {resetPoint.childWorkflowIds?.length})</span
                    >
                  {:else if resetPoint.source === 'child'}
                    <span class="text-gray-500">(child)</span>
                  {/if}
                </Option>
              {/each}
            {/if}
          </Select>
        {/if}
      {/if}

      <!-- Show cascade progress if available -->
      {#if cascadeProgress}
        <div class="rounded bg-blue-50 p-3 text-sm text-blue-900">
          {cascadeProgress}
        </div>
      {/if}
      {#if $isCloud || minimumVersionRequired('1.24.0', $temporalVersion)}
        <Checkbox
          id="reset-exclude-signals-checkbox"
          data-testid="reset-exclude-signals-checkbox"
          bind:checked={excludeSignals}
          label={translate('workflows.reset-exclude-signals')}
        />
        <Checkbox
          id="reset-exclude-updates-checkbox"
          data-testid="reset-exclude-updates-checkbox"
          bind:checked={excludeUpdates}
          label={translate('workflows.reset-exclude-updates')}
        />
      {:else}
        <Checkbox
          id="reset-include-signals-checkbox"
          data-testid="reset-include-signals-checkbox"
          bind:checked={includeSignals}
          label={translate('workflows.reset-reapply-type-label')}
        />
      {/if}

      <Input
        id="reset-reason"
        bind:value={reason}
        label={translate('common.reason')}
      />

      <!-- {#if $isCloud || minimumVersionRequired('1.28.0', $temporalVersion)} -->
      <Select
        id="reset-override-behavior-select"
        data-testid="reset-override-behavior-select"
        bind:value={overrideBehavior}
        label={translate('workflows.reset-override-behavior-label')}
      >
        <Option value="pinned">Pinned</Option>
        <Option value="unspecified">Auto-Upgrade</Option>
      </Select>
      <Input
        id="reset-deployment-name"
        data-testid="reset-deployment-name"
        bind:value={deploymentName}
        label={translate('workflows.reset-deployment-name-label')}
      />
      <Input
        id="reset-build-id"
        data-testid="reset-build-id"
        bind:value={buildId}
        label={translate('workflows.reset-build-id-label')}
      />
    </div>
  </svelte:fragment>
</Modal>
