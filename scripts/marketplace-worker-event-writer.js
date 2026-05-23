const {
  appendListingEvent,
  appendWorkflowEvent,
  hashContent,
} = require('./marketplace-homepage-db');
const {
  EVENT_SCOPES,
  validateWorkerEvent,
} = require('./marketplace-worker-events');

function baseEventInput(event) {
  const workerType = String(event.workerType || event.worker_type || '').trim();
  const strategy = String(event.strategy || event.workerStrategy || event.worker_strategy || '').trim();
  const payload = {
    workerType,
    strategy,
    ...(event.payload || {}),
  };
  return {
    eventType: event.eventType || event.event_type,
    workerType,
    strategy,
    payload,
  };
}

function appendRegulatedWorkflowEvent(db, event) {
  const input = baseEventInput(event);
  const validation = validateWorkerEvent(input);
  if (validation.definition.scope !== EVENT_SCOPES.WORKFLOW) {
    throw new Error(`Event ${validation.eventType} is not a workflow event`);
  }

  return appendWorkflowEvent(db, {
    eventId: event.eventId || event.event_id,
    workflowRunId: event.workflowRunId || event.workflow_run_id || event.workerId || event.worker_id,
    eventType: validation.eventType,
    eventAt: event.eventAt || event.event_at,
    status: event.status || '',
    content: input.payload,
    error: event.error || '',
  });
}

function appendRegulatedListingEvent(db, event) {
  const input = baseEventInput(event);
  const validation = validateWorkerEvent(input);
  if (validation.definition.scope !== EVENT_SCOPES.LISTING) {
    throw new Error(`Event ${validation.eventType} is not a listing event`);
  }

  const listingId = String(event.listingId || event.listing_id || input.payload.listingId || '').trim();
  if (!listingId) {
    throw new Error(`Event ${validation.eventType} requires listingId`);
  }
  const content = event.content || input.payload;
  const contentHash = event.contentHash || event.content_hash || hashContent(content);

  return appendListingEvent(db, {
    eventId: event.eventId || event.event_id,
    workflowRunId: event.workflowRunId || event.workflow_run_id || event.workerId || event.worker_id,
    listingId,
    eventType: validation.eventType,
    eventAt: event.eventAt || event.event_at,
    workerId: event.workerId || event.worker_id,
    sourceUrl: event.sourceUrl || event.source_url || input.payload.href || '',
    attempt: Number.isFinite(event.attempt) ? event.attempt : Number(input.payload.attempt || 0),
    status: event.status || input.payload.status || '',
    content,
    contentHash,
    screenshotPath: event.screenshotPath || event.screenshot_path || input.payload.screenshotPath || '',
    snapshotPath: event.snapshotPath || event.snapshot_path || input.payload.snapshotPath || '',
    error: event.error || input.payload.errorMessage || input.payload.reason || '',
  });
}

module.exports = {
  appendRegulatedWorkflowEvent,
  appendRegulatedListingEvent,
};
