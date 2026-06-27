const WORKER_TYPES = Object.freeze({
  COLLECTOR: 'collector',
  RESOLVER: 'resolver',
  BACKLOG_INDEXER: 'backlog_indexer',
  PROFILE_ONBOARDER: 'profile_onboarder',
});

const WORKER_STRATEGIES = Object.freeze({
  collector: Object.freeze(['feed', 'search', 'explorer']),
  resolver: Object.freeze(['queue', 'selected', 'filtered']),
  backlog_indexer: Object.freeze(['resolved_metadata']),
  profile_onboarder: Object.freeze(['guided_login']),
});

const EVENT_SCOPES = Object.freeze({
  WORKFLOW: 'workflow',
  LISTING: 'listing',
  RESOLVE_QUEUE: 'resolve_queue',
  COMMAND: 'command',
});

const EVENT_CHANNELS = Object.freeze({
  DB: 'db',
  STDOUT_JSONL: 'stdout_jsonl',
  LIVE: 'live',
});

function freezeDefinition(definition) {
  return Object.freeze({
    ...definition,
    workerTypes: Object.freeze([...(definition.workerTypes || [])]),
    strategies: Object.freeze([...(definition.strategies || [])]),
    requiredPayloadKeys: Object.freeze([...(definition.requiredPayloadKeys || [])]),
    optionalPayloadKeys: Object.freeze([...(definition.optionalPayloadKeys || [])]),
    channels: Object.freeze([...(definition.channels || [EVENT_CHANNELS.DB, EVENT_CHANNELS.LIVE])]),
  });
}

const EVENT_DEFINITIONS = Object.freeze([
  freezeDefinition({
    eventType: 'worker_started',
    scope: EVENT_SCOPES.WORKFLOW,
    table: 'workflow_events',
    workerTypes: [WORKER_TYPES.COLLECTOR, WORKER_TYPES.RESOLVER, WORKER_TYPES.BACKLOG_INDEXER, WORKER_TYPES.PROFILE_ONBOARDER],
    requiredPayloadKeys: ['workerType', 'strategy'],
    optionalPayloadKeys: ['mode', 'args', 'profileId', 'profileDir', 'interactive'],
  }),
  freezeDefinition({
    eventType: 'worker_heartbeat',
    scope: EVENT_SCOPES.WORKFLOW,
    table: 'workflow_events',
    workerTypes: [WORKER_TYPES.COLLECTOR, WORKER_TYPES.RESOLVER, WORKER_TYPES.BACKLOG_INDEXER, WORKER_TYPES.PROFILE_ONBOARDER],
    requiredPayloadKeys: ['workerType', 'strategy'],
    optionalPayloadKeys: ['activeListingId', 'activeCommandId', 'profileId', 'leaseExpiresAt', 'processedCount', 'step'],
  }),
  freezeDefinition({
    eventType: 'worker_sleeping',
    scope: EVENT_SCOPES.WORKFLOW,
    table: 'workflow_events',
    workerTypes: [WORKER_TYPES.COLLECTOR, WORKER_TYPES.RESOLVER, WORKER_TYPES.BACKLOG_INDEXER, WORKER_TYPES.PROFILE_ONBOARDER],
    requiredPayloadKeys: ['seconds'],
    optionalPayloadKeys: ['reason', 'jitterMultiplier', 'acceptedInputs', 'prompt'],
  }),
  freezeDefinition({
    eventType: 'worker_completed',
    scope: EVENT_SCOPES.WORKFLOW,
    table: 'workflow_events',
    workerTypes: [WORKER_TYPES.COLLECTOR, WORKER_TYPES.RESOLVER, WORKER_TYPES.BACKLOG_INDEXER, WORKER_TYPES.PROFILE_ONBOARDER],
    optionalPayloadKeys: ['reason', 'processedCount', 'observedCount', 'attemptedCount'],
  }),
  freezeDefinition({
    eventType: 'worker_failed',
    scope: EVENT_SCOPES.WORKFLOW,
    table: 'workflow_events',
    workerTypes: [WORKER_TYPES.COLLECTOR, WORKER_TYPES.RESOLVER, WORKER_TYPES.BACKLOG_INDEXER, WORKER_TYPES.PROFILE_ONBOARDER],
    optionalPayloadKeys: ['activeListingId', 'activeCommandId', 'reason'],
  }),
  freezeDefinition({
    eventType: 'shutdown_requested',
    scope: EVENT_SCOPES.WORKFLOW,
    table: 'workflow_events',
    workerTypes: [WORKER_TYPES.COLLECTOR, WORKER_TYPES.RESOLVER, WORKER_TYPES.BACKLOG_INDEXER, WORKER_TYPES.PROFILE_ONBOARDER],
    requiredPayloadKeys: ['signal'],
    optionalPayloadKeys: ['activeListingId', 'activeCommandId'],
  }),
  freezeDefinition({
    eventType: 'profile_lease_acquired',
    scope: EVENT_SCOPES.WORKFLOW,
    table: 'workflow_events',
    workerTypes: [WORKER_TYPES.COLLECTOR, WORKER_TYPES.RESOLVER, WORKER_TYPES.PROFILE_ONBOARDER],
    requiredPayloadKeys: ['profileId', 'profileDir', 'leaseExpiresAt'],
  }),
  freezeDefinition({
    eventType: 'profile_lease_rejected',
    scope: EVENT_SCOPES.WORKFLOW,
    table: 'workflow_events',
    workerTypes: [WORKER_TYPES.COLLECTOR, WORKER_TYPES.RESOLVER, WORKER_TYPES.PROFILE_ONBOARDER],
    requiredPayloadKeys: ['profileId', 'reason'],
    optionalPayloadKeys: ['ownerId', 'leaseExpiresAt'],
  }),
  freezeDefinition({
    eventType: 'profile_lease_released',
    scope: EVENT_SCOPES.WORKFLOW,
    table: 'workflow_events',
    workerTypes: [WORKER_TYPES.COLLECTOR, WORKER_TYPES.RESOLVER, WORKER_TYPES.PROFILE_ONBOARDER],
    requiredPayloadKeys: ['profileId'],
    optionalPayloadKeys: ['reason'],
  }),
  freezeDefinition({
    eventType: 'browser_context_launch_started',
    scope: EVENT_SCOPES.WORKFLOW,
    table: 'workflow_events',
    workerTypes: [WORKER_TYPES.COLLECTOR, WORKER_TYPES.RESOLVER],
    requiredPayloadKeys: ['userDataDir', 'headless'],
  }),
  freezeDefinition({
    eventType: 'browser_context_ready',
    scope: EVENT_SCOPES.WORKFLOW,
    table: 'workflow_events',
    workerTypes: [WORKER_TYPES.COLLECTOR, WORKER_TYPES.RESOLVER],
    requiredPayloadKeys: ['userDataDir', 'headless'],
  }),
  freezeDefinition({
    eventType: 'browser_context_closing',
    scope: EVENT_SCOPES.WORKFLOW,
    table: 'workflow_events',
    workerTypes: [WORKER_TYPES.COLLECTOR, WORKER_TYPES.RESOLVER],
    optionalPayloadKeys: ['reason'],
  }),
  freezeDefinition({
    eventType: 'browser_context_closed',
    scope: EVENT_SCOPES.WORKFLOW,
    table: 'workflow_events',
    workerTypes: [WORKER_TYPES.COLLECTOR, WORKER_TYPES.RESOLVER],
    optionalPayloadKeys: ['reason'],
  }),
  freezeDefinition({
    eventType: 'session_ready',
    scope: EVENT_SCOPES.WORKFLOW,
    table: 'workflow_events',
    workerTypes: [WORKER_TYPES.COLLECTOR, WORKER_TYPES.RESOLVER],
    requiredPayloadKeys: ['loggedIn'],
    optionalPayloadKeys: ['signedInUserId', 'currentUrl', 'loadedEmail'],
  }),
  freezeDefinition({
    eventType: 'auth_required',
    scope: EVENT_SCOPES.WORKFLOW,
    table: 'workflow_events',
    workerTypes: [WORKER_TYPES.COLLECTOR, WORKER_TYPES.RESOLVER],
    requiredPayloadKeys: ['reason'],
    optionalPayloadKeys: ['currentUrl', 'checkpointType'],
  }),
  freezeDefinition({
    eventType: 'collector_cycle_started',
    scope: EVENT_SCOPES.WORKFLOW,
    table: 'workflow_events',
    workerTypes: [WORKER_TYPES.COLLECTOR],
    strategies: WORKER_STRATEGIES.collector,
    requiredPayloadKeys: ['strategy'],
    optionalPayloadKeys: ['startUrl', 'query', 'area', 'maxItems', 'collectAll'],
  }),
  freezeDefinition({
    eventType: 'collector_query_selected',
    scope: EVENT_SCOPES.WORKFLOW,
    table: 'workflow_events',
    workerTypes: [WORKER_TYPES.COLLECTOR],
    strategies: ['search', 'explorer'],
    requiredPayloadKeys: ['query'],
    optionalPayloadKeys: ['querySource', 'roundNumber', 'nextSeedRound'],
  }),
  freezeDefinition({
    eventType: 'listing_observed',
    scope: EVENT_SCOPES.LISTING,
    table: 'listing_events',
    workerTypes: [WORKER_TYPES.COLLECTOR],
    strategies: WORKER_STRATEGIES.collector,
    requiredPayloadKeys: ['listingId', 'href', 'source', 'outcome'],
    optionalPayloadKeys: ['sourceKeyword', 'rank', 'cardTitle', 'cardText'],
  }),
  freezeDefinition({
    eventType: 'collector_cycle_completed',
    scope: EVENT_SCOPES.WORKFLOW,
    table: 'workflow_events',
    workerTypes: [WORKER_TYPES.COLLECTOR],
    strategies: WORKER_STRATEGIES.collector,
    requiredPayloadKeys: ['strategy', 'observedCount'],
    optionalPayloadKeys: ['newCount', 'existingSameCount', 'existingUpdatedCount', 'snapshotPath'],
  }),
  freezeDefinition({
    eventType: 'collector_cycle_failed',
    scope: EVENT_SCOPES.WORKFLOW,
    table: 'workflow_events',
    workerTypes: [WORKER_TYPES.COLLECTOR],
    strategies: WORKER_STRATEGIES.collector,
    requiredPayloadKeys: ['strategy', 'reason'],
    optionalPayloadKeys: ['query', 'startUrl'],
  }),
  freezeDefinition({
    eventType: 'backlog_index_started',
    scope: EVENT_SCOPES.WORKFLOW,
    table: 'workflow_events',
    workerTypes: [WORKER_TYPES.BACKLOG_INDEXER],
    strategies: WORKER_STRATEGIES.backlog_indexer,
    requiredPayloadKeys: ['strategy'],
    optionalPayloadKeys: ['limit', 'staleOnly'],
  }),
  freezeDefinition({
    eventType: 'backlog_index_completed',
    scope: EVENT_SCOPES.WORKFLOW,
    table: 'workflow_events',
    workerTypes: [WORKER_TYPES.BACKLOG_INDEXER],
    strategies: WORKER_STRATEGIES.backlog_indexer,
    requiredPayloadKeys: ['strategy', 'processedCount'],
    optionalPayloadKeys: ['scanned', 'normalized', 'unparsed', 'skipped', 'missing'],
  }),
  freezeDefinition({
    eventType: 'backlog_index_failed',
    scope: EVENT_SCOPES.WORKFLOW,
    table: 'workflow_events',
    workerTypes: [WORKER_TYPES.BACKLOG_INDEXER],
    strategies: WORKER_STRATEGIES.backlog_indexer,
    requiredPayloadKeys: ['strategy', 'reason'],
  }),
  freezeDefinition({
    eventType: 'backlog_listing_metadata_indexed',
    scope: EVENT_SCOPES.LISTING,
    table: 'listing_events',
    workerTypes: [WORKER_TYPES.BACKLOG_INDEXER],
    strategies: WORKER_STRATEGIES.backlog_indexer,
    requiredPayloadKeys: ['indexerVersion'],
    optionalPayloadKeys: ['listingId', 'listedAtMin', 'listedAtMax', 'confidence', 'fieldsUpdated'],
  }),
  freezeDefinition({
    eventType: 'backlog_listing_metadata_skipped',
    scope: EVENT_SCOPES.LISTING,
    table: 'listing_events',
    workerTypes: [WORKER_TYPES.BACKLOG_INDEXER],
    strategies: WORKER_STRATEGIES.backlog_indexer,
    requiredPayloadKeys: ['reason'],
    optionalPayloadKeys: ['listingId', 'indexerVersion'],
  }),
  freezeDefinition({
    eventType: 'backlog_listing_metadata_failed',
    scope: EVENT_SCOPES.LISTING,
    table: 'listing_events',
    workerTypes: [WORKER_TYPES.BACKLOG_INDEXER],
    strategies: WORKER_STRATEGIES.backlog_indexer,
    requiredPayloadKeys: ['reason'],
    optionalPayloadKeys: ['listingId', 'indexerVersion', 'retryable'],
  }),
  freezeDefinition({
    eventType: 'profile_onboarding_started',
    scope: EVENT_SCOPES.WORKFLOW,
    table: 'workflow_events',
    workerTypes: [WORKER_TYPES.PROFILE_ONBOARDER],
    strategies: WORKER_STRATEGIES.profile_onboarder,
    requiredPayloadKeys: ['strategy', 'profileDir'],
    optionalPayloadKeys: ['credentialsProfile', 'headless'],
  }),
  freezeDefinition({
    eventType: 'profile_onboarding_step',
    scope: EVENT_SCOPES.WORKFLOW,
    table: 'workflow_events',
    workerTypes: [WORKER_TYPES.PROFILE_ONBOARDER],
    strategies: WORKER_STRATEGIES.profile_onboarder,
    requiredPayloadKeys: ['strategy', 'step'],
    optionalPayloadKeys: ['prompt', 'acceptedInputs', 'screenshotPath', 'url', 'title'],
  }),
  freezeDefinition({
    eventType: 'credentials_submitted',
    scope: EVENT_SCOPES.WORKFLOW,
    table: 'workflow_events',
    workerTypes: [WORKER_TYPES.PROFILE_ONBOARDER],
    strategies: WORKER_STRATEGIES.profile_onboarder,
    requiredPayloadKeys: ['strategy'],
    optionalPayloadKeys: ['emailFilled', 'passwordFilled', 'submitted', 'screenshotPath'],
  }),
  freezeDefinition({
    eventType: 'verification_required',
    scope: EVENT_SCOPES.WORKFLOW,
    table: 'workflow_events',
    workerTypes: [WORKER_TYPES.PROFILE_ONBOARDER],
    strategies: WORKER_STRATEGIES.profile_onboarder,
    requiredPayloadKeys: ['strategy', 'prompt'],
    optionalPayloadKeys: ['acceptedInputs', 'screenshotPath', 'url'],
  }),
  freezeDefinition({
    eventType: 'external_approval_required',
    scope: EVENT_SCOPES.WORKFLOW,
    table: 'workflow_events',
    workerTypes: [WORKER_TYPES.PROFILE_ONBOARDER],
    strategies: WORKER_STRATEGIES.profile_onboarder,
    requiredPayloadKeys: ['strategy', 'prompt'],
    optionalPayloadKeys: ['acceptedInputs', 'screenshotPath', 'url'],
  }),
  freezeDefinition({
    eventType: 'user_command_received',
    scope: EVENT_SCOPES.WORKFLOW,
    table: 'workflow_events',
    workerTypes: [WORKER_TYPES.PROFILE_ONBOARDER],
    strategies: WORKER_STRATEGIES.profile_onboarder,
    requiredPayloadKeys: ['strategy', 'commandType'],
    optionalPayloadKeys: ['commandId', 'actor'],
  }),
  freezeDefinition({
    eventType: 'profile_ready',
    scope: EVENT_SCOPES.WORKFLOW,
    table: 'workflow_events',
    workerTypes: [WORKER_TYPES.PROFILE_ONBOARDER],
    strategies: WORKER_STRATEGIES.profile_onboarder,
    requiredPayloadKeys: ['strategy'],
    optionalPayloadKeys: ['signedInUserId', 'currentUrl', 'screenshotPath'],
  }),
  freezeDefinition({
    eventType: 'profile_onboarding_failed',
    scope: EVENT_SCOPES.WORKFLOW,
    table: 'workflow_events',
    workerTypes: [WORKER_TYPES.PROFILE_ONBOARDER],
    strategies: WORKER_STRATEGIES.profile_onboarder,
    requiredPayloadKeys: ['strategy', 'reason'],
    optionalPayloadKeys: ['step', 'screenshotPath'],
  }),
  freezeDefinition({
    eventType: 'resolver_idle',
    scope: EVENT_SCOPES.WORKFLOW,
    table: 'workflow_events',
    workerTypes: [WORKER_TYPES.RESOLVER],
    strategies: WORKER_STRATEGIES.resolver,
    requiredPayloadKeys: ['strategy'],
    optionalPayloadKeys: ['pending', 'processing', 'error'],
  }),
  freezeDefinition({
    eventType: 'detail_capture_started',
    scope: EVENT_SCOPES.LISTING,
    table: 'listing_events',
    workerTypes: [WORKER_TYPES.RESOLVER],
    strategies: WORKER_STRATEGIES.resolver,
    requiredPayloadKeys: ['listingId', 'href', 'attempt'],
    optionalPayloadKeys: ['claimId', 'source', 'sourceKeyword'],
  }),
  freezeDefinition({
    eventType: 'detail_capture_succeeded',
    scope: EVENT_SCOPES.LISTING,
    table: 'listing_events',
    workerTypes: [WORKER_TYPES.RESOLVER],
    strategies: WORKER_STRATEGIES.resolver,
    requiredPayloadKeys: ['listingId', 'attempt'],
    optionalPayloadKeys: ['claimId', 'title', 'price', 'screenshotPath', 'snapshotPath', 'contentHash'],
  }),
  freezeDefinition({
    eventType: 'detail_capture_bypassed',
    scope: EVENT_SCOPES.LISTING,
    table: 'listing_events',
    workerTypes: [WORKER_TYPES.RESOLVER],
    strategies: WORKER_STRATEGIES.resolver,
    requiredPayloadKeys: ['listingId', 'attempt', 'reason'],
    optionalPayloadKeys: ['claimId', 'availabilityStatus', 'screenshotPath', 'snapshotPath'],
  }),
  freezeDefinition({
    eventType: 'content_changed',
    scope: EVENT_SCOPES.LISTING,
    table: 'listing_events',
    workerTypes: [WORKER_TYPES.RESOLVER],
    strategies: WORKER_STRATEGIES.resolver,
    requiredPayloadKeys: ['listingId', 'previousContentHash', 'nextContentHash'],
    optionalPayloadKeys: ['claimId', 'attempt', 'screenshotPath', 'snapshotPath'],
  }),
  freezeDefinition({
    eventType: 'detail_capture_failed',
    scope: EVENT_SCOPES.LISTING,
    table: 'listing_events',
    workerTypes: [WORKER_TYPES.RESOLVER],
    strategies: WORKER_STRATEGIES.resolver,
    requiredPayloadKeys: ['listingId', 'attempt', 'errorMessage'],
    optionalPayloadKeys: ['claimId', 'errorCode', 'retryable'],
  }),
  freezeDefinition({
    eventType: 'detail_capture_interrupted',
    scope: EVENT_SCOPES.LISTING,
    table: 'listing_events',
    workerTypes: [WORKER_TYPES.RESOLVER],
    strategies: WORKER_STRATEGIES.resolver,
    requiredPayloadKeys: ['listingId', 'attempt', 'reason'],
    optionalPayloadKeys: ['claimId', 'signal', 'retryable'],
  }),
  freezeDefinition({
    eventType: 'listing_unavailable',
    scope: EVENT_SCOPES.LISTING,
    table: 'listing_events',
    workerTypes: [WORKER_TYPES.RESOLVER],
    strategies: WORKER_STRATEGIES.resolver,
    requiredPayloadKeys: ['listingId', 'attempt', 'reason'],
    optionalPayloadKeys: ['claimId', 'unavailableSignal'],
  }),
  freezeDefinition({
    eventType: 'resolve_queue_added',
    scope: EVENT_SCOPES.RESOLVE_QUEUE,
    table: 'resolve_queue_events',
    workerTypes: [WORKER_TYPES.RESOLVER],
    requiredPayloadKeys: ['listingId'],
    optionalPayloadKeys: ['previousStatus'],
  }),
  freezeDefinition({
    eventType: 'resolve_queue_requeued',
    scope: EVENT_SCOPES.RESOLVE_QUEUE,
    table: 'resolve_queue_events',
    workerTypes: [WORKER_TYPES.RESOLVER],
    requiredPayloadKeys: ['listingId', 'previousStatus'],
  }),
  freezeDefinition({
    eventType: 'resolve_queue_dispatched',
    scope: EVENT_SCOPES.RESOLVE_QUEUE,
    table: 'resolve_queue_events',
    workerTypes: [WORKER_TYPES.RESOLVER],
    requiredPayloadKeys: ['listingId', 'workflowRunId'],
  }),
  freezeDefinition({
    eventType: 'resolve_queue_completed',
    scope: EVENT_SCOPES.RESOLVE_QUEUE,
    table: 'resolve_queue_events',
    workerTypes: [WORKER_TYPES.RESOLVER],
    requiredPayloadKeys: ['listingId', 'workflowStatus'],
  }),
  freezeDefinition({
    eventType: 'resolve_queue_failed',
    scope: EVENT_SCOPES.RESOLVE_QUEUE,
    table: 'resolve_queue_events',
    workerTypes: [WORKER_TYPES.RESOLVER],
    requiredPayloadKeys: ['listingId', 'workflowStatus'],
    optionalPayloadKeys: ['error'],
  }),
  freezeDefinition({
    eventType: 'resolve_queue_cleared',
    scope: EVENT_SCOPES.RESOLVE_QUEUE,
    table: 'resolve_queue_events',
    workerTypes: [WORKER_TYPES.RESOLVER],
    requiredPayloadKeys: ['listingId', 'previousStatus'],
  }),
  freezeDefinition({
    eventType: 'browser_command_claimed',
    scope: EVENT_SCOPES.COMMAND,
    table: 'worker_event_log',
    workerTypes: [WORKER_TYPES.COLLECTOR, WORKER_TYPES.RESOLVER],
    requiredPayloadKeys: ['commandId', 'claimId', 'commandType'],
  }),
  freezeDefinition({
    eventType: 'browser_command_started',
    scope: EVENT_SCOPES.COMMAND,
    table: 'worker_event_log',
    workerTypes: [WORKER_TYPES.COLLECTOR, WORKER_TYPES.RESOLVER],
    requiredPayloadKeys: ['commandId', 'claimId', 'commandType'],
  }),
  freezeDefinition({
    eventType: 'browser_command_succeeded',
    scope: EVENT_SCOPES.COMMAND,
    table: 'worker_event_log',
    workerTypes: [WORKER_TYPES.COLLECTOR, WORKER_TYPES.RESOLVER],
    requiredPayloadKeys: ['commandId', 'claimId'],
    optionalPayloadKeys: ['result'],
  }),
  freezeDefinition({
    eventType: 'browser_command_failed',
    scope: EVENT_SCOPES.COMMAND,
    table: 'worker_event_log',
    workerTypes: [WORKER_TYPES.COLLECTOR, WORKER_TYPES.RESOLVER],
    requiredPayloadKeys: ['commandId', 'claimId', 'error'],
  }),
]);

const EVENT_DEFINITION_BY_TYPE = Object.freeze(Object.fromEntries(
  EVENT_DEFINITIONS.map((definition) => [definition.eventType, definition]),
));

function normalizeWorkerType(workerType) {
  const normalized = String(workerType || '').trim().toLowerCase();
  if (!Object.values(WORKER_TYPES).includes(normalized)) {
    throw new Error(`Unknown worker type: ${workerType}`);
  }
  return normalized;
}

function normalizeWorkerStrategy(workerType, strategy) {
  const normalizedWorkerType = normalizeWorkerType(workerType);
  const normalizedStrategy = String(strategy || '').trim().toLowerCase();
  if (!WORKER_STRATEGIES[normalizedWorkerType].includes(normalizedStrategy)) {
    throw new Error(`Unknown ${normalizedWorkerType} strategy: ${strategy}`);
  }
  return normalizedStrategy;
}

function getWorkerEventDefinition(eventType) {
  return EVENT_DEFINITION_BY_TYPE[String(eventType || '').trim()] || null;
}

function listWorkerEventDefinitions(options = {}) {
  const workerType = options.workerType ? normalizeWorkerType(options.workerType) : '';
  const strategy = options.strategy && workerType
    ? normalizeWorkerStrategy(workerType, options.strategy)
    : '';
  return EVENT_DEFINITIONS.filter((definition) => {
    if (workerType && !definition.workerTypes.includes(workerType)) {
      return false;
    }
    if (strategy && definition.strategies.length > 0 && !definition.strategies.includes(strategy)) {
      return false;
    }
    return true;
  });
}

function validateWorkerEvent(event) {
  const eventType = String(event?.eventType || event?.event_type || '').trim();
  const definition = getWorkerEventDefinition(eventType);
  if (!definition) {
    throw new Error(`Unknown worker event type: ${eventType || '(empty)'}`);
  }

  const workerType = normalizeWorkerType(event.workerType || event.worker_type);
  if (!definition.workerTypes.includes(workerType)) {
    throw new Error(`Event ${eventType} is not valid for worker type ${workerType}`);
  }

  const strategyValue = event.strategy || event.workerStrategy || event.worker_strategy || '';
  if (strategyValue) {
    const strategy = normalizeWorkerStrategy(workerType, strategyValue);
    if (definition.strategies.length > 0 && !definition.strategies.includes(strategy)) {
      throw new Error(`Event ${eventType} is not valid for ${workerType} strategy ${strategy}`);
    }
  }

  const payload = event.payload && typeof event.payload === 'object' ? event.payload : {};
  const missingKeys = definition.requiredPayloadKeys.filter((key) => (
    payload[key] === undefined || payload[key] === null || payload[key] === ''
  ));
  if (missingKeys.length > 0) {
    throw new Error(`Event ${eventType} missing required payload keys: ${missingKeys.join(', ')}`);
  }

  return {
    eventType,
    workerType,
    strategy: strategyValue ? normalizeWorkerStrategy(workerType, strategyValue) : '',
    definition,
  };
}

module.exports = {
  WORKER_TYPES,
  WORKER_STRATEGIES,
  EVENT_SCOPES,
  EVENT_CHANNELS,
  EVENT_DEFINITIONS,
  normalizeWorkerType,
  normalizeWorkerStrategy,
  getWorkerEventDefinition,
  listWorkerEventDefinitions,
  validateWorkerEvent,
};
