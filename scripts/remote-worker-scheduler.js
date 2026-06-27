function boundedNumber(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function decideRemoteWorkerSchedulerState(input = {}) {
  const reasons = [];
  const hostState = String(input.hostState || 'offline').trim();
  const activeClaims = boundedNumber(input.activeClaims);
  const maxConcurrentClaims = Math.max(0, boundedNumber(input.maxConcurrentClaims, 1));
  const pendingEventCount = boundedNumber(input.pendingEventCount);
  const maxLocalPendingEvents = boundedNumber(input.maxLocalPendingEvents, 10000);
  const pendingArtifactBytes = boundedNumber(input.pendingArtifactBytes);
  const maxLocalArtifactBytes = boundedNumber(input.maxLocalArtifactBytes, 1024 * 1024 * 1024);
  const diskFreeMb = boundedNumber(input.diskFreeMb, Number.POSITIVE_INFINITY);
  const minDiskFreeMb = boundedNumber(input.minDiskFreeMb, 512);

  if (input.shutdownRequested) {
    return { state: 'stopping', canClaim: false, reasons: ['shutdown_requested'] };
  }
  if (hostState !== 'connected') {
    return { state: 'offline', canClaim: false, reasons: ['host_offline'] };
  }
  if (input.drainRequested) {
    return { state: 'draining', canClaim: false, reasons: ['drain_requested'] };
  }
  if (activeClaims >= maxConcurrentClaims) {
    reasons.push('claim_limit');
  }
  if (pendingEventCount > maxLocalPendingEvents) {
    reasons.push('pending_event_limit');
  }
  if (pendingArtifactBytes > maxLocalArtifactBytes) {
    reasons.push('pending_artifact_limit');
  }
  if (diskFreeMb < minDiskFreeMb) {
    reasons.push('disk_free_limit');
  }
  if (reasons.length > 0) {
    return { state: 'backpressure', canClaim: false, reasons };
  }
  return { state: 'claiming', canClaim: true, reasons };
}

function estimateEventBytes(event) {
  if (typeof event.payloadJson === 'string') return Buffer.byteLength(event.payloadJson, 'utf8');
  return Buffer.byteLength(JSON.stringify(event), 'utf8');
}

function planRemoteWorkerEventBatch(events = [], options = {}) {
  const maxEventBatchSize = Math.max(1, boundedNumber(options.maxEventBatchSize, 100));
  const maxEventBatchBytes = Math.max(1, boundedNumber(options.maxEventBatchBytes, 256 * 1024));
  const pending = events
    .filter((event) => String(event.status || 'pending') === 'pending')
    .sort((left, right) => boundedNumber(left.sequence) - boundedNumber(right.sequence));

  const selected = [];
  let totalBytes = 0;
  for (const event of pending) {
    const eventBytes = estimateEventBytes(event);
    if (selected.length >= maxEventBatchSize) break;
    if (selected.length > 0 && totalBytes + eventBytes > maxEventBatchBytes) break;
    selected.push(event);
    totalBytes += eventBytes;
  }

  return {
    events: selected,
    firstSequence: selected.length ? selected[0].sequence : null,
    lastSequence: selected.length ? selected[selected.length - 1].sequence : null,
    totalBytes,
    hasMore: pending.length > selected.length,
  };
}

module.exports = {
  decideRemoteWorkerSchedulerState,
  planRemoteWorkerEventBatch,
};
