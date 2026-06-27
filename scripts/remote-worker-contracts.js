const DISALLOWED_PAYLOAD_KEYS = new Set([
  'sql',
  'statement',
  'code',
  'script',
  'shell',
  'commandLine',
  'filesystemWrite',
  'reducer',
  'reducerPatch',
]);

const EXCHANGE_TYPES = Object.freeze({
  task: 'TaskEnvelope',
  remote_event: 'RemoteEventEnvelope',
  heartbeat: 'HeartbeatSnapshot',
  artifact_manifest: 'ArtifactManifest',
});

const ALLOWED_TASK_TYPES = new Set([
  'index_resolved_listing_metadata_batch',
  'collect_search_results',
  'resolve_backlog_listing',
  'observe_external_workflow',
  'profile_onboarding_step',
]);

function assertObject(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
}

function requireString(value, label) {
  const text = String(value || '').trim();
  if (!text) {
    throw new Error(`${label} is required`);
  }
  return text;
}

function rejectDisallowedPayload(value, path = 'payload') {
  if (!value || typeof value !== 'object') return;
  if (Array.isArray(value)) {
    value.forEach((item, index) => rejectDisallowedPayload(item, `${path}[${index}]`));
    return;
  }
  Object.entries(value).forEach(([key, child]) => {
    if (DISALLOWED_PAYLOAD_KEYS.has(key)) {
      throw new Error(`disallowed payload key at ${path}.${key}`);
    }
    rejectDisallowedPayload(child, `${path}.${key}`);
  });
}

function classifyExchangeEnvelope(envelope) {
  assertObject(envelope, 'exchange envelope');
  const exchangeType = String(envelope.exchangeType || '').trim();
  const classification = EXCHANGE_TYPES[exchangeType];
  if (!classification) {
    throw new Error(`unsupported exchange type: ${exchangeType || '(empty)'}`);
  }
  return classification;
}

function normalizeTaskEnvelope(envelope) {
  assertObject(envelope, 'task envelope');
  const taskType = requireString(envelope.taskType, 'taskType');
  if (!ALLOWED_TASK_TYPES.has(taskType)) {
    throw new Error(`unsupported task type: ${taskType}`);
  }
  const payload = envelope.payload && typeof envelope.payload === 'object' ? envelope.payload : {};
  rejectDisallowedPayload(payload);
  const normalized = {
    exchangeType: 'task',
    schemaVersion: envelope.schemaVersion || 'remote-worker-task@1',
    taskId: requireString(envelope.taskId, 'taskId'),
    taskSource: requireString(envelope.taskSource, 'taskSource'),
    taskType,
    workerType: requireString(envelope.workerType, 'workerType'),
    strategy: String(envelope.strategy || '').trim(),
    dedupeKey: String(envelope.dedupeKey || '').trim(),
    entityType: String(envelope.entityType || '').trim(),
    entityId: String(envelope.entityId || '').trim(),
    lease: envelope.lease && typeof envelope.lease === 'object' ? { ...envelope.lease } : {},
    payload,
    createdAt: envelope.createdAt || new Date().toISOString(),
  };
  return normalized;
}

function validateRemoteEventEnvelope(envelope) {
  assertObject(envelope, 'remote event envelope');
  const sequence = Number(envelope.sequence);
  if (!Number.isInteger(sequence) || sequence < 1) {
    throw new Error('sequence must be a positive integer');
  }
  const normalized = {
    exchangeType: 'remote_event',
    schemaVersion: envelope.schemaVersion || 'remote-worker-event@1',
    sessionId: requireString(envelope.sessionId, 'sessionId'),
    workerId: requireString(envelope.workerId, 'workerId'),
    workerType: String(envelope.workerType || '').trim(),
    strategy: String(envelope.strategy || '').trim(),
    eventId: requireString(envelope.eventId, 'eventId'),
    sequence,
    eventAt: envelope.eventAt || envelope.event_at || new Date().toISOString(),
    eventScope: requireString(envelope.eventScope || envelope.event_scope, 'eventScope'),
    eventType: requireString(envelope.eventType || envelope.event_type, 'eventType'),
    listingId: String(envelope.listingId || envelope.listing_id || '').trim(),
    status: String(envelope.status || '').trim(),
    payload: envelope.payload && typeof envelope.payload === 'object' ? envelope.payload : {},
  };
  rejectDisallowedPayload(normalized.payload);
  return normalized;
}

function validateArtifactItem(item, options, label) {
  assertObject(item, label);
  const manifest = {
    ...item,
    artifactId: requireString(item.artifactId, `${label}.artifactId`),
    artifactType: requireString(item.artifactType || 'image', `${label}.artifactType`),
    mediaRole: requireString(item.mediaRole, `${label}.mediaRole`),
    contentType: requireString(item.contentType, `${label}.contentType`),
    sha256: requireString(item.sha256, `${label}.sha256`),
    sizeBytes: Number(item.sizeBytes),
  };
  if (!/^[a-f0-9]{64}$/i.test(manifest.sha256)) {
    throw new Error(`${label}.sha256 must be a 64 character hex digest`);
  }
  if (!Number.isFinite(manifest.sizeBytes) || manifest.sizeBytes < 0) {
    throw new Error(`${label}.sizeBytes must be a positive number`);
  }
  if (options.maxArtifactBytes && manifest.sizeBytes > options.maxArtifactBytes) {
    throw new Error(`artifact ${manifest.artifactId} too large`);
  }
  if (item.bytesBase64 || item.binary || item.buffer) {
    throw new Error('inline binary artifacts are not allowed');
  }
  if (item.storage && typeof item.storage === 'object') {
    const secretKeys = ['accessKeyId', 'secretAccessKey', 'sessionToken', 'connectionString'];
    if (secretKeys.some((key) => item.storage[key])) {
      throw new Error('storage credentials must not be included in artifact manifests');
    }
  }
  return manifest;
}

function validateArtifactManifest(envelope, options = {}) {
  const manifest = validateArtifactItem(envelope, options, 'artifact');
  return {
    exchangeType: 'artifact_manifest',
    schemaVersion: envelope.schemaVersion || 'remote-worker-artifact@1',
    ...manifest,
    derivatives: Array.isArray(envelope.derivatives)
      ? envelope.derivatives.map((item, index) => validateArtifactItem(item, options, `derivatives[${index}]`))
      : [],
    metadata: envelope.metadata && typeof envelope.metadata === 'object' ? envelope.metadata : {},
    storage: envelope.storage && typeof envelope.storage === 'object' ? envelope.storage : {},
  };
}

module.exports = {
  classifyExchangeEnvelope,
  normalizeTaskEnvelope,
  validateRemoteEventEnvelope,
  validateArtifactManifest,
};
