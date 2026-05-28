const fs = require('fs');
const os = require('os');
const path = require('path');
const test = require('node:test');
const assert = require('node:assert/strict');

const {
  extractListingId,
  canonicalizeListingUrl,
  openMarketplaceHomepageDatabase,
  closeMarketplaceHomepageDatabase,
  normalizeKeyword,
  upsertHomepageListingWithStatus,
  upsertHomepageListing,
  listBacklogCandidates,
  claimNextPendingHomepageListing,
  markHomepageListingProcessed,
  markHomepageListingFailed,
  releaseHomepageListingClaim,
  markHomepageListingInactive,
  getHomepageListingCounts,
  createPurchaseHistoryDocument,
  listPurchaseHistoryDocuments,
  getPurchaseHistoryRow,
  upsertPurchaseHistoryRows,
  listPurchaseHistoryRows,
  upsertPurchaseHistoryListingLink,
  listPurchaseHistoryListingLinks,
  scanPurchaseHistoryMatchesForListings,
  scanPurchaseHistoryListingMatches,
  listPurchaseHistoryMatchQueue,
  listRandomPurchaseHistoryMatches,
  countPurchaseHistoryMatchQueue,
  listPurchaseHistoryEvents,
  mergePurchaseHistoryDocuments,
  runTransaction,
  appendListingEvent,
  appendWorkflowEvent,
  addResolveQueueItems,
  clearResolveQueueItems,
  markResolveQueueDispatched,
  refreshResolveQueueRunStatuses,
  listResolveQueueItems,
  listResolveQueueEvents,
  getResolveQueueCounts,
  listWorkflowEvents,
  getListingEvents,
  getLatestListingEvent,
  hashContent,
  upsertListingSearchKeyword,
  upsertSearchTitleBagKeyword,
  getSearchTitleBagKeyword,
  pickRandomSearchTitleBagKeyword,
  getSearchTitleBagCounts,
  insertWorkflowRun,
  updateWorkflowRun,
  getWorkflowRun,
  listWorkflowRuns,
  resolveWorkerEventIdsForRun,
  listWorkerListingEvents,
  listWorkerAuditEvents,
  getWorkerListingEventStats,
  getWorkerAuditEventStats,
  getDatabaseMaintenanceReport,
  runDatabaseMaintenance,
} = require('../scripts/marketplace-homepage-db');

function createTempDbPath() {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'marketplace-homepage-db-'));
  return path.join(tempDir, 'queue.db');
}

test('extractListingId and canonicalizeListingUrl normalize Marketplace links', () => {
  const sourceUrl = 'https://www.facebook.com/marketplace/item/123456789/?ref=search&tracking=abc';
  assert.equal(extractListingId(sourceUrl), '123456789');
  assert.equal(
    canonicalizeListingUrl(sourceUrl),
    'https://www.facebook.com/marketplace/item/123456789/',
  );
});

test('listing events are append-only detail history', () => {
  const dbPath = createTempDbPath();
  const { db } = openMarketplaceHomepageDatabase(dbPath);

  try {
    upsertHomepageListing(db, {
      listingId: 'event-1',
      href: 'https://www.facebook.com/marketplace/item/601/',
      title: 'Pentax 67',
      text: 'CA$ 1500 | Pentax 67',
      rank: 1,
    });

    const content = {
      detail: {
        title: 'Pentax 67',
        price: 'CA$ 1500',
      },
    };
    const contentHash = hashContent(content.detail);
    const event = appendListingEvent(db, {
      workflowRunId: 'run-worker-a',
      listingId: 'event-1',
      eventType: 'detail_capture_succeeded',
      eventAt: '2026-05-07T00:00:00.000Z',
      workerId: 'worker-a',
      sourceUrl: 'https://www.facebook.com/marketplace/item/601/',
      attempt: 1,
      status: 'done',
      content,
      contentHash,
      screenshotPath: '/tmp/601.png',
      snapshotPath: '/tmp/601.md',
    });

    assert.equal(event.listing_id, 'event-1');
    assert.equal(event.workflow_run_id, 'run-worker-a');
    assert.equal(event.event_type, 'detail_capture_succeeded');
    assert.equal(event.content_hash, contentHash);

    appendListingEvent(db, {
      listingId: 'event-1',
      eventType: 'content_changed',
      eventAt: '2026-05-07T00:01:00.000Z',
      workerId: 'worker-a',
      sourceUrl: 'https://www.facebook.com/marketplace/item/601/',
      attempt: 2,
      status: 'changed',
      content: {
        previousContentHash: contentHash,
        nextContentHash: 'next-hash',
      },
      contentHash: 'next-hash',
    });

    const events = getListingEvents(db, 'event-1');
    assert.equal(events.length, 2);
    assert.equal(events[0].event_type, 'content_changed');

    const latestSuccess = getLatestListingEvent(db, 'event-1', {
      eventType: 'detail_capture_succeeded',
    });
    assert.equal(latestSuccess.event_id, event.event_id);
  } finally {
    closeMarketplaceHomepageDatabase(db);
  }
});

test('worker event helpers group audit events by category', () => {
  const dbPath = createTempDbPath();
  const { db } = openMarketplaceHomepageDatabase(dbPath);

  try {
    upsertHomepageListing(db, {
      listingId: 'worker-event-1',
      href: 'https://www.facebook.com/marketplace/item/611/',
      title: 'Worker event row',
      text: 'CA$ 100 | Worker event row',
      rank: 1,
    });

    appendListingEvent(db, {
      workflowRunId: 'workflow-run-1',
      listingId: 'worker-event-1',
      eventType: 'detail_capture_started',
      eventAt: '2026-05-08T00:00:00.000Z',
      workerId: 'run-worker-1',
      status: 'processing',
      content: { detail: { title: 'Worker event row' } },
    });
    appendListingEvent(db, {
      workflowRunId: 'workflow-run-1',
      listingId: 'worker-event-1',
      eventType: 'detail_capture_succeeded',
      eventAt: '2026-05-08T00:01:00.000Z',
      workerId: 'run-worker-1',
      status: 'done',
      content: { detail: { title: 'Worker event row', price: 'CA$ 100' } },
      screenshotPath: '/tmp/611.png',
    });
    appendListingEvent(db, {
      workflowRunId: 'workflow-run-1',
      listingId: 'worker-event-1',
      eventType: 'detail_capture_bypassed',
      eventAt: '2026-05-08T00:02:00.000Z',
      workerId: 'run-worker-1',
      status: 'sold',
      content: { detail: { availabilityReason: 'sold_signal' } },
    });
    appendWorkflowEvent(db, {
      workflowRunId: 'workflow-run-1',
      eventType: 'collector_cycle_started',
      eventAt: '2026-05-09T00:00:00.000Z',
      status: 'running',
      content: { query: 'pentax' },
    });

    const stats = getWorkerListingEventStats(db, 'run-worker-1');
    assert.equal(stats.started, 1);
    assert.equal(stats.done, 1);
    assert.equal(stats.skipped, 1);
    assert.equal(stats.total, 3);

    const doneEvents = listWorkerListingEvents(db, 'run-worker-1', { category: 'done' });
    assert.equal(doneEvents.length, 1);
    assert.equal(doneEvents[0].content.detail.price, 'CA$ 100');

    const runStats = getWorkerListingEventStats(db, 'workflow-run-1');
    assert.equal(runStats.total, 3);

    const auditStats = getWorkerAuditEventStats(db, 'workflow-run-1');
    assert.equal(auditStats.listingTotal, 3);
    assert.equal(auditStats.workflow, 1);
    assert.equal(auditStats.total, 4);
    assert.equal(auditStats.latestEvent.event_type, 'collector_cycle_started');

    const allEvents = listWorkerAuditEvents(db, 'workflow-run-1', { category: 'all' });
    assert.equal(allEvents.length, 4);
    assert.equal(allEvents[0].event_scope, 'workflow');

    const workflowEvents = listWorkerAuditEvents(db, 'workflow-run-1', { category: 'workflow' });
    assert.equal(workflowEvents.length, 1);
    assert.equal(workflowEvents[0].content.query, 'pentax');
  } finally {
    closeMarketplaceHomepageDatabase(db);
  }
});

test('collector worker stats use listing outcomes for shared columns', () => {
  const dbPath = createTempDbPath();
  const { db } = openMarketplaceHomepageDatabase(dbPath);

  try {
    for (const [listingId, title] of [
      ['collector-event-1', 'New collector listing'],
      ['collector-event-2', 'Updated collector listing'],
      ['collector-event-3', 'Same collector listing'],
    ]) {
      upsertHomepageListing(db, {
        listingId,
        href: `https://www.facebook.com/marketplace/item/${listingId}/`,
        title,
        text: `CA$ 100 | ${title}`,
        rank: 1,
      });
    }

    appendListingEvent(db, {
      workflowRunId: 'collector-run-1',
      workerId: 'collector-run-1',
      listingId: 'collector-event-1',
      eventType: 'listing_observed',
      eventAt: '2026-05-08T01:00:00.000Z',
      status: 'new',
    });
    appendListingEvent(db, {
      workflowRunId: 'collector-run-1',
      workerId: 'collector-run-1',
      listingId: 'collector-event-2',
      eventType: 'listing_observed',
      eventAt: '2026-05-08T01:01:00.000Z',
      status: 'existing_updated',
    });
    appendListingEvent(db, {
      workflowRunId: 'collector-run-1',
      workerId: 'collector-run-1',
      listingId: 'collector-event-3',
      eventType: 'listing_observed',
      eventAt: '2026-05-08T01:02:00.000Z',
      status: 'existing_same',
    });
    appendWorkflowEvent(db, {
      workflowRunId: 'collector-run-1',
      eventType: 'worker_failed',
      eventAt: '2026-05-08T01:03:00.000Z',
      status: 'error',
      error: 'browser closed',
    });

    const stats = getWorkerAuditEventStats(db, 'collector-run-1');
    assert.equal(stats.started, 3);
    assert.equal(stats.done, 2);
    assert.equal(stats.skipped, 1);
    assert.equal(stats.error, 1);
    assert.equal(stats.workflowReview, 1);

    assert.equal(listWorkerAuditEvents(db, 'collector-run-1', { category: 'started' }).length, 3);
    assert.equal(listWorkerAuditEvents(db, 'collector-run-1', { category: 'done' }).length, 2);
    assert.equal(listWorkerAuditEvents(db, 'collector-run-1', { category: 'skipped' }).length, 1);

    const reviewEvents = listWorkerAuditEvents(db, 'collector-run-1', { category: 'error' });
    assert.equal(reviewEvents.length, 1);
    assert.equal(reviewEvents[0].event_scope, 'workflow');
    assert.equal(reviewEvents[0].event_type, 'worker_failed');
  } finally {
    closeMarketplaceHomepageDatabase(db);
  }
});

test('worker event helpers link legacy pid audit rows to workflow runs', () => {
  const dbPath = createTempDbPath();
  const { db } = openMarketplaceHomepageDatabase(dbPath);

  try {
    upsertHomepageListing(db, {
      listingId: 'legacy-worker-1',
      href: 'https://www.facebook.com/marketplace/item/621/',
      title: 'Legacy worker row',
      text: 'CA$ 100 | Legacy worker row',
      rank: 1,
    });

    insertWorkflowRun(db, {
      runId: 'workflow-run-legacy',
      workflowId: 'backlog-worker',
      label: 'Continuous Backlog Worker',
      script: 'marketplace:home:process',
      args: ['--headless'],
      pid: 9001,
      status: 'failed',
      startedAt: '2026-05-09T00:00:00.000Z',
      logs: [
        '[2026-05-09T00:00:10.000Z] job_start listing_id=legacy-worker-1 attempt=1',
        '[2026-05-09T00:00:11.000Z] job_error listing_id=legacy-worker-1 error="closed"',
      ],
    });
    updateWorkflowRun(db, 'workflow-run-legacy', {
      exitedAt: '2026-05-09T00:02:00.000Z',
      status: 'failed',
    });

    appendListingEvent(db, {
      listingId: 'legacy-worker-1',
      eventType: 'detail_capture_succeeded',
      eventAt: '2026-05-09T00:00:20.000Z',
      workerId: 'pid-9002',
      status: 'done',
      content: { detail: { title: 'Legacy worker row', price: 'CA$ 100' } },
      screenshotPath: '/tmp/legacy-worker-1.png',
    });
    appendListingEvent(db, {
      listingId: 'legacy-worker-1',
      eventType: 'detail_capture_failed',
      eventAt: '2026-05-09T00:00:40.000Z',
      workerId: 'pid-9002',
      status: 'error',
      error: 'browser closed',
    });

    const workerIds = resolveWorkerEventIdsForRun(db, 'workflow-run-legacy');
    assert.deepEqual(workerIds, ['workflow-run-legacy', 'pid-9002']);

    const stats = getWorkerListingEventStats(db, 'workflow-run-legacy', { workerIds });
    assert.equal(stats.total, 2);
    assert.equal(stats.done, 1);
    assert.equal(stats.error, 1);
    assert.equal(stats.latestEvent.event_type, 'detail_capture_failed');
    assert.equal(stats.latestPreviewEvent.event_type, 'detail_capture_succeeded');

    const errorEvents = listWorkerListingEvents(db, 'workflow-run-legacy', {
      category: 'error',
      workerIds,
    });
    assert.equal(errorEvents.length, 1);
    assert.equal(errorEvents[0].worker_id, 'pid-9002');
  } finally {
    closeMarketplaceHomepageDatabase(db);
  }
});

test('purchase history documents store rows and merge by record id', () => {
  const dbPath = createTempDbPath();
  const { db } = openMarketplaceHomepageDatabase(dbPath);

  try {
    const primary = createPurchaseHistoryDocument(db, {
      name: 'Primary History',
    });
    const imported = createPurchaseHistoryDocument(db, {
      name: 'Imported CSV',
    });

    upsertPurchaseHistoryRows(db, primary.document_id, [{
      record_id: 'trade-001',
      category: 'camera_gear',
      subcategory: 'camera_body',
      brand: 'nikon',
      model: 'fm2',
      mount: 'f-mount',
      title: 'Nikon FM2',
      purchase_price_cad: '200',
      purchase_at: '2026-05-01',
      inventory_status: 'hold',
      outcome: 'pending',
    }]);

    upsertPurchaseHistoryRows(db, primary.document_id, [{
      record_id: 'trade-001',
      category: 'camera_gear',
      subcategory: 'camera_body',
      brand: 'nikon',
      model: 'fm2',
      mount: 'f-mount',
      title: 'Nikon FM2',
      purchase_price_cad: '200',
      purchase_at: '2026-05-01',
      listed_at: '2026-05-03',
      list_price_cad: '320',
      inventory_status: 'listed',
      outcome: 'pending',
    }]);

    upsertPurchaseHistoryRows(db, primary.document_id, [{
      record_id: 'trade-001',
      category: 'camera_gear',
      subcategory: 'camera_body',
      brand: 'nikon',
      model: 'fm2',
      mount: 'f-mount',
      title: 'Nikon FM2',
      purchase_price_cad: '200',
      purchase_at: '2026-05-01',
      listed_at: '2026-05-03',
      sold_at: '2026-05-05',
      sold_price_cad: '300',
      inventory_status: 'sold',
      outcome: 'sold_profitable',
    }]);

    assert.deepEqual(
      listPurchaseHistoryEvents(db, { documentId: primary.document_id, recordId: 'trade-001' })
        .map((event) => event.event_type)
        .sort(),
      ['inventory_added', 'listed', 'sold'],
    );

    upsertPurchaseHistoryRows(db, imported.document_id, [
      {
        record_id: 'trade-001',
        category: 'camera_gear',
        subcategory: 'camera_body',
        brand: 'nikon',
        model: 'fm2',
        mount: 'f-mount',
        title: 'Nikon FM2 updated',
        purchase_price_cad: '220',
        outcome: 'pending',
      },
      {
        record_id: 'trade-002',
        category: 'camera_gear',
        subcategory: 'lens',
        brand: 'pentax',
        model: '67-105mm',
        mount: 'pentax-67',
        title: 'Pentax 67 105mm',
        purchase_price_cad: '450',
        outcome: 'pending',
      },
    ]);

    const merge = mergePurchaseHistoryDocuments(db, {
      sourceDocumentId: imported.document_id,
      targetDocumentId: primary.document_id,
    });
    assert.equal(merge.inserted, 1);
    assert.equal(merge.updated, 1);

    const rows = listPurchaseHistoryRows(db, primary.document_id);
    assert.equal(rows.length, 2);
    assert.equal(rows.find((row) => row.record_id === 'trade-001').data.title, 'Nikon FM2 updated');
    assert.equal(listPurchaseHistoryDocuments(db).length, 2);
  } finally {
    closeMarketplaceHomepageDatabase(db);
  }
});

test('purchase history records can link same listing and same model Marketplace rows', () => {
  const dbPath = createTempDbPath();
  const { db } = openMarketplaceHomepageDatabase(dbPath);

  try {
    const document = createPurchaseHistoryDocument(db, {
      name: 'Linked History',
    });
    upsertPurchaseHistoryRows(db, document.document_id, [{
      record_id: 'trade-link-001',
      category: 'camera_gear',
      subcategory: 'camera_body',
      brand: 'sigma',
      model: 'dp1m',
      title: 'SIGMA DP1M',
      purchase_price_cad: '300',
      inventory_status: 'hold',
      outcome: 'pending',
    }]);
    upsertHomepageListing(db, {
      listingId: '963267799804615',
      href: 'https://www.facebook.com/marketplace/item/963267799804615/?tracking=abc',
      title: 'SIGMA DP1 Merrill',
      text: 'CA$ 550 | SIGMA DP1 Merrill',
    }, {
      source: 'manual',
      sourceKeyword: 'same_listing',
    });
    upsertHomepageListing(db, {
      listingId: '963267799804616',
      href: 'https://www.facebook.com/marketplace/item/963267799804616/',
      title: 'SIGMA DP1M comp',
      text: 'CA$ 520 | SIGMA DP1M comp',
    }, {
      source: 'manual',
      sourceKeyword: 'same_model',
    });

    upsertPurchaseHistoryListingLink(db, {
      documentId: document.document_id,
      recordId: 'trade-link-001',
      listingId: '963267799804615',
      href: 'https://www.facebook.com/marketplace/item/963267799804615/?tracking=abc',
      relationshipType: 'same_listing',
    }, {
      linkedAt: '2026-05-23T18:00:00.000Z',
    });
    upsertPurchaseHistoryListingLink(db, {
      documentId: document.document_id,
      recordId: 'trade-link-001',
      listingId: '963267799804616',
      href: 'https://www.facebook.com/marketplace/item/963267799804616/',
      relationshipType: 'same_model',
    }, {
      linkedAt: '2026-05-23T18:01:00.000Z',
    });

    assert.equal(getPurchaseHistoryRow(db, document.document_id, 'trade-link-001').title, 'SIGMA DP1M');
    const links = listPurchaseHistoryListingLinks(db, {
      documentId: document.document_id,
      recordId: 'trade-link-001',
    });
    assert.deepEqual(
      links.map((link) => [link.listing_id, link.relationship_type]),
      [
        ['963267799804616', 'same_model'],
        ['963267799804615', 'same_listing'],
      ],
    );
    assert.equal(links[1].href, 'https://www.facebook.com/marketplace/item/963267799804615/');
    assert.equal(
      listPurchaseHistoryEvents(db, { documentId: document.document_id, recordId: 'trade-link-001' })
        .filter((event) => event.event_type === 'listing_linked')
        .length,
      2,
    );
  } finally {
    closeMarketplaceHomepageDatabase(db);
  }
});

test('purchase history match queue captures below-threshold matching listings incrementally', () => {
  const dbPath = createTempDbPath();
  const { db } = openMarketplaceHomepageDatabase(dbPath);

  try {
    const document = createPurchaseHistoryDocument(db, {
      name: 'Watch History',
    });
    upsertPurchaseHistoryRows(db, document.document_id, [{
      record_id: 'watch-001',
      category: 'camera_gear',
      subcategory: 'camera_body',
      brand: 'nikon',
      model: 'fm2',
      title: 'Nikon FM2',
      description: 'black 35mm film camera',
      purchase_price_cad: '200',
      inventory_status: 'hold',
      outcome: 'pending',
    }]);
    upsertPurchaseHistoryRows(db, document.document_id, [{
      record_id: 'watch-002',
      category: 'camera_gear',
      subcategory: 'lens',
      brand: 'nikon',
      model: 'AF-S NIKKOR 28-70 1:2.8D',
      title: 'AF-S NIKKOR 28-70 1:2.8D',
      purchase_price_cad: '600',
      inventory_status: 'hold',
      outcome: 'pending',
    }]);
    upsertHomepageListing(db, {
      listingId: 'watch-listing-1',
      href: 'https://www.facebook.com/marketplace/item/8001/',
      title: 'Nikon FM2 body',
      text: 'CA$ 210 | Nikon FM2 black body',
      rank: 1,
    }, {
      seenAt: '2026-05-25T00:00:00.000Z',
    });
    upsertHomepageListing(db, {
      listingId: 'watch-listing-2',
      href: 'https://www.facebook.com/marketplace/item/8002/',
      title: 'Nikon FM2 body',
      text: 'CA$ 260 | Nikon FM2 black body',
      rank: 2,
    }, {
      seenAt: '2026-05-25T00:01:00.000Z',
    });
    upsertHomepageListing(db, {
      listingId: 'watch-listing-numeric',
      href: 'https://www.facebook.com/marketplace/item/8004/',
      title: '78 and 12 magnetic levels',
      text: 'CA$ 55 | 78 and 12 magnetic levels',
      rank: 4,
    }, {
      seenAt: '2026-05-25T00:01:30.000Z',
    });

    const direct = scanPurchaseHistoryMatchesForListings(db, ['watch-listing-1', 'watch-listing-2', 'watch-listing-numeric'], {
      actor: 'test-history-watch',
      matchedAt: '2026-05-25T00:02:00.000Z',
    });
    assert.equal(direct.scanned, 3);
    assert.equal(direct.matched, 1);
    assert.equal(direct.queued, 1);

    const matches = listPurchaseHistoryMatchQueue(db);
    assert.equal(matches.length, 1);
    assert.equal(matches[0].listing_id, 'watch-listing-1');
    assert.equal(matches[0].record_id, 'watch-001');
    assert.ok(matches[0].matched_terms.includes('fm2'));
    assert.equal(listResolveQueueItems(db).some((item) => item.listing_id === 'watch-listing-1'), true);
    upsertHomepageListing(db, {
      listingId: 'watch-listing-3',
      href: 'https://www.facebook.com/marketplace/item/8003/',
      title: 'Film gear',
      text: 'CA$ 199 | Nikon FM2 kit',
      rank: 3,
    }, {
      seenAt: '2026-05-25T00:03:00.000Z',
    });
    const scheduled = scanPurchaseHistoryListingMatches(db, {
      limit: 1,
      now: '2026-05-25T00:04:00.000Z',
      initialLookbackMs: 2 * 60 * 1000,
    });
    assert.equal(scheduled.scanned, 1);
    assert.equal(scheduled.matched, 1);
    assert.equal(listPurchaseHistoryMatchQueue(db).some((item) => item.listing_id === 'watch-listing-3'), true);
    assert.equal(countPurchaseHistoryMatchQueue(db, { resolvedOnly: true }), 0);
    assert.equal(listPurchaseHistoryMatchQueue(db, { resolvedOnly: true }).length, 0);

    markHomepageListingProcessed(db, 'watch-listing-1', {
      title: 'Nikon FM2 silver body',
      listingContent: {
        price: 'CA$ 240',
        location: 'Vancouver',
        condition: 'Good',
        sellerName: 'Camera Seller',
      },
      screenshotPath: '/tmp/fm2.png',
      snapshotPath: '/tmp/fm2.md',
    });
    assert.equal(countPurchaseHistoryMatchQueue(db, { resolvedOnly: true }), 1);
    assert.equal(listPurchaseHistoryMatchQueue(db, { resolvedOnly: true })[0].listing_id, 'watch-listing-1');
    assert.equal(listRandomPurchaseHistoryMatches(db, { resolvedOnly: true, limit: 3 })[0].listing_id, 'watch-listing-1');
  } finally {
    closeMarketplaceHomepageDatabase(db);
  }
});

test('claimNextPendingHomepageListing can append start event in claim transaction', () => {
  const dbPath = createTempDbPath();
  const { db } = openMarketplaceHomepageDatabase(dbPath);

  try {
    upsertHomepageListing(db, {
      listingId: 'claim-start-1',
      href: 'https://www.facebook.com/marketplace/item/631/',
      title: 'Claim start row',
      text: 'CA$ 100 | Claim start row',
      rank: 1,
    });

    const claimed = claimNextPendingHomepageListing(db, {
      workerId: 'workflow-run-claim',
      statusFilter: 'pending',
      claimedAt: '2026-05-09T00:00:00.000Z',
      startEventBuilder: (listing) => ({
        workflowRunId: 'workflow-run-claim',
        listingId: listing.listing_id,
        eventType: 'detail_capture_started',
        workerId: 'workflow-run-claim',
        status: 'processing',
        attempt: listing.detail_attempts,
        content: { listingId: listing.listing_id },
      }),
    });

    assert.equal(claimed.listing_id, 'claim-start-1');
    const events = listWorkerListingEvents(db, 'workflow-run-claim', { category: 'started' });
    assert.equal(events.length, 1);
    assert.equal(events[0].workflow_run_id, 'workflow-run-claim');
  } finally {
    closeMarketplaceHomepageDatabase(db);
  }
});

test('runTransaction atomically writes event and listing status', () => {
  const dbPath = createTempDbPath();
  const { db } = openMarketplaceHomepageDatabase(dbPath);

  try {
    upsertHomepageListing(db, {
      listingId: 'transaction-1',
      href: 'https://www.facebook.com/marketplace/item/632/',
      title: 'Transaction row',
      text: 'CA$ 100 | Transaction row',
      rank: 1,
    });

    runTransaction(db, () => {
      appendListingEvent(db, {
        workflowRunId: 'workflow-run-transaction',
        listingId: 'transaction-1',
        eventType: 'detail_capture_failed',
        workerId: 'workflow-run-transaction',
        status: 'error',
        error: 'test error',
      });
      markHomepageListingFailed(db, 'transaction-1', 'test error');
    });

    assert.equal(getHomepageListingCounts(db).error, 1);
    assert.equal(getWorkerListingEventStats(db, 'workflow-run-transaction').error, 1);
  } finally {
    closeMarketplaceHomepageDatabase(db);
  }
});

test('workflow runs persist process state and logs', () => {
  const dbPath = createTempDbPath();
  const { db } = openMarketplaceHomepageDatabase(dbPath);

  try {
    const created = insertWorkflowRun(db, {
      runId: 'run-1',
      workflowId: 'search-explore',
      label: 'Search Explorer',
      script: 'marketplace:search:explore',
      args: ['--query', 'pentax'],
      pid: 12345,
      status: 'running',
      startedAt: '2026-05-08T00:00:00.000Z',
      osAlive: true,
      logs: ['started'],
    });

    assert.equal(created.run_id, 'run-1');
    assert.deepEqual(created.args, ['--query', 'pentax']);
    assert.equal(created.os_alive, true);

    const updated = updateWorkflowRun(db, 'run-1', {
      status: 'exited',
      exitedAt: '2026-05-08T00:01:00.000Z',
      exitCode: 0,
      osAlive: false,
      osCheckedAt: '2026-05-08T00:01:01.000Z',
      logs: ['started', 'done'],
    });

    assert.equal(updated.status, 'exited');
    assert.equal(updated.exit_code, 0);
    assert.equal(updated.os_alive, false);
    assert.deepEqual(getWorkflowRun(db, 'run-1').logs, ['started', 'done']);
    assert.equal(listWorkflowRuns(db).length, 1);
  } finally {
    closeMarketplaceHomepageDatabase(db);
  }
});

test('schema includes read-path and audit indexes', () => {
  const dbPath = createTempDbPath();
  const { db } = openMarketplaceHomepageDatabase(dbPath);

  try {
    const indexes = db.prepare(`
      SELECT name
      FROM sqlite_master
      WHERE type = 'index'
    `).all().map((row) => row.name);
    assert.ok(indexes.includes('idx_homepage_listings_recent'));
    assert.ok(indexes.includes('idx_homepage_listings_completed'));
    assert.ok(indexes.includes('idx_listing_events_workflow_time'));
    assert.ok(indexes.includes('idx_listing_events_worker_time'));
    assert.ok(indexes.includes('idx_workflow_events_run_time'));
    assert.ok(indexes.includes('idx_workflow_events_type_time'));
    assert.ok(indexes.includes('idx_resolve_queue_items_status_updated'));
    assert.ok(indexes.includes('idx_resolve_queue_events_listing_time'));
    assert.ok(indexes.includes('idx_resolve_queue_events_type_time'));
  } finally {
    closeMarketplaceHomepageDatabase(db);
  }
});

test('resolve queue persists items and append-only audit events', () => {
  const dbPath = createTempDbPath();
  const { db } = openMarketplaceHomepageDatabase(dbPath);

  try {
    upsertHomepageListing(db, {
      listingId: 'queue-1',
      href: 'https://www.facebook.com/marketplace/item/801/',
      title: 'Queued one',
      text: 'CA$ 100 | Queued one',
      rank: 1,
    });
    upsertHomepageListing(db, {
      listingId: 'queue-2',
      href: 'https://www.facebook.com/marketplace/item/802/',
      title: 'Queued two',
      text: 'CA$ 200 | Queued two',
      rank: 2,
    });

    const added = addResolveQueueItems(db, ['queue-1', 'queue-2', 'missing'], {
      queuedAt: '2026-05-11T00:00:00.000Z',
      actor: 'test',
    });
    assert.equal(added.addedCount, 2);
    assert.deepEqual(added.skippedIds, ['missing']);
    assert.equal(getResolveQueueCounts(db).queued, 2);
    assert.deepEqual(listResolveQueueItems(db).map((item) => item.listing_id), ['queue-1', 'queue-2']);
    assert.equal(listResolveQueueEvents(db).length, 2);

    const cleared = clearResolveQueueItems(db, ['queue-1'], {
      clearedAt: '2026-05-11T00:01:00.000Z',
      actor: 'test',
    });
    assert.equal(cleared.clearedCount, 1);
    assert.deepEqual(listResolveQueueItems(db, { statuses: ['queued'] }).map((item) => item.listing_id), ['queue-2']);
    assert.equal(getResolveQueueCounts(db).cleared, 1);
    assert.equal(listResolveQueueEvents(db).length, 3);
  } finally {
    closeMarketplaceHomepageDatabase(db);
  }
});

test('resolve queue dispatch tracks workflow terminal status', () => {
  const dbPath = createTempDbPath();
  const { db } = openMarketplaceHomepageDatabase(dbPath);

  try {
    upsertHomepageListing(db, {
      listingId: 'dispatch-1',
      href: 'https://www.facebook.com/marketplace/item/811/',
      title: 'Dispatch one',
      text: 'CA$ 100 | Dispatch one',
      rank: 1,
    });
    addResolveQueueItems(db, ['dispatch-1'], {
      queuedAt: '2026-05-11T00:00:00.000Z',
      actor: 'test',
    });
    insertWorkflowRun(db, {
      runId: 'run-dispatch',
      workflowId: 'backlog-worker',
      label: 'Resolve',
      script: 'marketplace:home:process',
      args: [],
      pid: 123,
      status: 'running',
      startedAt: '2026-05-11T00:02:00.000Z',
      osAlive: true,
      logs: [],
    });

    markResolveQueueDispatched(db, ['dispatch-1'], 'run-dispatch', {
      dispatchedAt: '2026-05-11T00:02:01.000Z',
      actor: 'test',
    });
    assert.equal(getResolveQueueCounts(db).dispatched, 1);

    updateWorkflowRun(db, 'run-dispatch', {
      status: 'failed',
      exitedAt: '2026-05-11T00:03:00.000Z',
      exitCode: 1,
      osAlive: false,
    });
    const refreshed = refreshResolveQueueRunStatuses(db);
    assert.equal(refreshed.updatedCount, 1);
    assert.equal(getResolveQueueCounts(db).failed, 1);
    assert.equal(listResolveQueueItems(db, { statuses: ['failed'] })[0].workflow_run_id, 'run-dispatch');
    assert.equal(listResolveQueueEvents(db)[0].event_type, 'resolve_queue_failed');
  } finally {
    closeMarketplaceHomepageDatabase(db);
  }
});

test('database maintenance reports size and can run optimize/checkpoint', () => {
  const dbPath = createTempDbPath();
  const { db } = openMarketplaceHomepageDatabase(dbPath);

  try {
    upsertHomepageListing(db, {
      listingId: 'maintenance-1',
      href: 'https://www.facebook.com/marketplace/item/641/',
      title: 'Maintenance row',
      text: 'CA$ 100 | Maintenance row',
      rank: 1,
    });

    const before = getDatabaseMaintenanceReport(db, dbPath);
    assert.equal(before.rows.homepageListings, 1);
    const result = runDatabaseMaintenance(db, dbPath, {
      optimize: true,
      checkpoint: true,
      analyze: false,
      vacuum: false,
    });
    assert.ok(result.actions.length >= 1);
    assert.equal(result.after.rows.homepageListings, 1);
  } finally {
    closeMarketplaceHomepageDatabase(db);
  }
});

test('normalizeKeyword trims and collapses whitespace', () => {
  assert.equal(normalizeKeyword('  nikon   d850  body  '), 'nikon d850 body');
});

test('upsertHomepageListing stores and refreshes homepage queue rows', () => {
  const dbPath = createTempDbPath();
  const { db } = openMarketplaceHomepageDatabase(dbPath);

  try {
    const first = upsertHomepageListing(db, {
      listingId: '100',
      href: 'https://www.facebook.com/marketplace/item/100/?ref=browse',
      title: 'First title',
      text: 'First card text',
      rank: 1,
    }, {
      seenAt: '2026-04-27T00:00:00.000Z',
    });

    assert.equal(first.listing_id, '100');
    assert.equal(first.detail_status, 'pending');
    assert.equal(first.last_seen_rank, 1);

    markHomepageListingProcessed(db, '100', {
      title: 'Processed title',
      listingContent: {
        title: 'Processed title',
        price: 'CA$100',
      },
      screenshotPath: '/tmp/100.png',
      snapshotPath: '/tmp/100.md',
    });

    const refreshed = upsertHomepageListing(db, {
      listingId: '100',
      href: 'https://www.facebook.com/marketplace/item/100/?ref=feed',
      title: 'Updated title',
      text: 'Updated card text',
      rank: 2,
    }, {
      seenAt: '2026-04-27T01:00:00.000Z',
    });

    assert.equal(refreshed.detail_status, 'done');
    assert.equal(refreshed.href, 'https://www.facebook.com/marketplace/item/100/');
    assert.equal(refreshed.card_title, 'Updated title');
    assert.equal(refreshed.last_seen_rank, 2);
  } finally {
    closeMarketplaceHomepageDatabase(db);
  }
});

test('upsertHomepageListingWithStatus reports new vs same vs updated content', () => {
  const dbPath = createTempDbPath();
  const { db } = openMarketplaceHomepageDatabase(dbPath);

  try {
    const created = upsertHomepageListingWithStatus(db, {
      listingId: '300',
      href: 'https://www.facebook.com/marketplace/item/300/?ref=browse',
      title: 'Same title',
      text: 'Same text',
      rank: 1,
    });
    assert.equal(created.outcome, 'new');

    const same = upsertHomepageListingWithStatus(db, {
      listingId: '300',
      href: 'https://www.facebook.com/marketplace/item/300/?ref=feed',
      title: 'Same title',
      text: 'Same text',
      rank: 1,
    });
    assert.equal(same.outcome, 'existing_same');
    assert.equal(same.sameContent, true);

    const updated = upsertHomepageListingWithStatus(db, {
      listingId: '300',
      href: 'https://www.facebook.com/marketplace/item/300/?ref=feed',
      title: 'Updated title',
      text: 'Updated text',
      rank: 2,
    });
    assert.equal(updated.outcome, 'existing_updated');
    assert.equal(updated.sameContent, false);
    assert.equal(updated.rankChanged, true);
  } finally {
    closeMarketplaceHomepageDatabase(db);
  }
});

test('upsertHomepageListingWithStatus stores source and source keyword for search rows', () => {
  const dbPath = createTempDbPath();
  const { db } = openMarketplaceHomepageDatabase(dbPath);

  try {
    const created = upsertHomepageListingWithStatus(db, {
      listingId: 'search-1',
      href: 'https://www.facebook.com/marketplace/item/400/?ref=search',
      title: 'Leica M6',
      text: 'CA$ 3800 | Leica M6',
    }, {
      source: 'search',
      sourceKeyword: 'leica m6',
      seenAt: '2026-04-29T00:00:00.000Z',
    });

    assert.equal(created.row.source, 'search');
    assert.equal(created.row.source_keyword, 'leica m6');
  } finally {
    closeMarketplaceHomepageDatabase(db);
  }
});

test('workflow events are append-only lifecycle history', () => {
  const dbPath = createTempDbPath();
  const { db } = openMarketplaceHomepageDatabase(dbPath);

  try {
    appendWorkflowEvent(db, {
      workflowRunId: 'worker-run-1',
      eventType: 'browser_context_launch_started',
      eventAt: '2026-05-11T00:00:00.000Z',
      status: 'starting',
      content: { headless: true },
    });
    appendWorkflowEvent(db, {
      workflowRunId: 'worker-run-1',
      eventType: 'browser_context_ready',
      eventAt: '2026-05-11T00:00:01.000Z',
      status: 'running',
      content: { pageCount: 1 },
    });

    const events = listWorkflowEvents(db, 'worker-run-1');
    assert.equal(events.length, 2);
    assert.equal(events[0].event_type, 'browser_context_ready');
    assert.deepEqual(events[0].content, { pageCount: 1 });
    assert.equal(events[1].event_type, 'browser_context_launch_started');
  } finally {
    closeMarketplaceHomepageDatabase(db);
  }
});

test('search keyword helpers keep title bag and listing keyword associations', () => {
  const dbPath = createTempDbPath();
  const { db } = openMarketplaceHomepageDatabase(dbPath);

  try {
    const row = upsertHomepageListing(db, {
      listingId: '500',
      href: 'https://www.facebook.com/marketplace/item/500/',
      title: 'Ricoh GR III',
      text: 'CA$ 1200 | Ricoh GR III',
      rank: 1,
    }, {
      source: 'search',
      sourceKeyword: 'ricoh gr',
      seenAt: '2026-04-29T00:00:00.000Z',
    });
    assert.equal(row.listing_id, '500');

    const bagEntry = upsertSearchTitleBagKeyword(db, 'Ricoh GR III', {
      sourceKeyword: 'ricoh gr',
      seenAt: '2026-04-29T00:00:00.000Z',
    });
    assert.equal(bagEntry.keyword, 'Ricoh GR III');
    assert.equal(bagEntry.times_seen, 1);

    upsertSearchTitleBagKeyword(db, 'Ricoh GR III', {
      sourceKeyword: 'ricoh gr',
      seenAt: '2026-04-29T01:00:00.000Z',
    });
    const refreshedBagEntry = getSearchTitleBagKeyword(db, 'ricoh gr iii');
    assert.equal(refreshedBagEntry.times_seen, 2);
    assert.equal(refreshedBagEntry.last_source_keyword, 'ricoh gr');

    const keywordLink = upsertListingSearchKeyword(db, '500', 'ricoh gr', {
      seenAt: '2026-04-29T00:00:00.000Z',
    });
    assert.equal(keywordLink.keyword, 'ricoh gr');
    assert.equal(keywordLink.times_seen, 1);

    const randomKeyword = pickRandomSearchTitleBagKeyword(db, {
      minTimesSeen: 2,
    });
    assert.equal(randomKeyword.keyword, 'Ricoh GR III');

    const bagCounts = getSearchTitleBagCounts(db);
    assert.equal(bagCounts.totalKeywords, 1);
    assert.equal(bagCounts.totalSeen, 2);
  } finally {
    closeMarketplaceHomepageDatabase(db);
  }
});

test('claimNextPendingHomepageListing prioritizes pending rows and tracks failures', () => {
  const dbPath = createTempDbPath();
  const { db } = openMarketplaceHomepageDatabase(dbPath);

  try {
    upsertHomepageListing(db, {
      listingId: '200',
      href: 'https://www.facebook.com/marketplace/item/200/',
      title: 'Second',
      text: 'Second card',
      rank: 2,
    });
    upsertHomepageListing(db, {
      listingId: '150',
      href: 'https://www.facebook.com/marketplace/item/150/',
      title: 'First',
      text: 'First card',
      rank: 1,
    });

    const claimed = claimNextPendingHomepageListing(db, {
      workerId: 'worker-a',
      staleAfterSeconds: 60,
      claimedAt: '2026-04-27T02:00:00.000Z',
    });
    assert.equal(claimed.listing_id, '150');
    assert.equal(claimed.detail_status, 'processing');
    assert.equal(claimed.claimed_by, 'worker-a');
    assert.equal(claimed.detail_attempts, 1);

    markHomepageListingFailed(db, claimed.listing_id, 'temporary failure');
    const counts = getHomepageListingCounts(db);
    assert.equal(counts.pending, 1);
    assert.equal(counts.error, 1);

    const next = claimNextPendingHomepageListing(db, {
      workerId: 'worker-b',
      staleAfterSeconds: 60,
      claimedAt: '2026-04-27T02:05:00.000Z',
    });
    assert.equal(next.listing_id, '200');
  } finally {
    closeMarketplaceHomepageDatabase(db);
  }
});

test('releaseHomepageListingClaim returns interrupted claims to backlog without spending attempts', () => {
  const dbPath = createTempDbPath();
  const { db } = openMarketplaceHomepageDatabase(dbPath);

  try {
    upsertHomepageListing(db, {
      listingId: 'interrupt-1',
      href: 'https://www.facebook.com/marketplace/item/9001/',
      title: 'Interrupted row',
      text: 'Card text',
      rank: 1,
    });

    const claimed = claimNextPendingHomepageListing(db, {
      workerId: 'worker-interrupt',
      staleAfterSeconds: 60,
      claimedAt: '2026-05-11T01:00:00.000Z',
    });
    assert.equal(claimed.detail_status, 'processing');
    assert.equal(claimed.detail_attempts, 1);

    const released = releaseHomepageListingClaim(db, claimed.listing_id, {
      workerId: 'worker-interrupt',
      nextStatus: 'pending',
      reason: 'worker_shutdown:SIGTERM',
      decrementAttempts: true,
      completedAt: '2026-05-11T01:00:05.000Z',
    });

    assert.equal(released.changed, true);
    assert.equal(released.listing.detail_status, 'pending');
    assert.equal(released.listing.claimed_by, '');
    assert.equal(released.listing.detail_attempts, 0);
    assert.equal(released.listing.detail_last_error, 'worker_shutdown:SIGTERM');
  } finally {
    closeMarketplaceHomepageDatabase(db);
  }
});

test('claimNextPendingHomepageListing respects max attempts and source filters', () => {
  const dbPath = createTempDbPath();
  const { db } = openMarketplaceHomepageDatabase(dbPath);

  try {
    upsertHomepageListing(db, {
      listingId: 'source-home',
      href: 'https://www.facebook.com/marketplace/item/701/',
      title: 'Homepage row',
      text: 'Homepage card',
      rank: 1,
    }, {
      source: 'homepage',
    });
    upsertHomepageListing(db, {
      listingId: 'source-search',
      href: 'https://www.facebook.com/marketplace/item/702/',
      title: 'Search row',
      text: 'Search card',
      rank: 2,
    }, {
      source: 'search',
      sourceKeyword: 'pentax',
    });

    const searchClaim = claimNextPendingHomepageListing(db, {
      workerId: 'worker-search',
      sourceFilter: 'search',
      keywordFilter: 'pentax',
      maxAttempts: 1,
      claimedAt: '2026-05-07T00:00:00.000Z',
    });
    assert.equal(searchClaim.listing_id, 'source-search');

    markHomepageListingFailed(db, 'source-search', 'temporary failure');
    const skippedAfterMaxAttempts = claimNextPendingHomepageListing(db, {
      workerId: 'worker-search',
      sourceFilter: 'search',
      keywordFilter: 'pentax',
      maxAttempts: 1,
      claimedAt: '2026-05-07T00:01:00.000Z',
    });
    assert.equal(skippedAfterMaxAttempts, null);

    const homepageClaim = claimNextPendingHomepageListing(db, {
      workerId: 'worker-home',
      sourceFilter: 'homepage',
      claimedAt: '2026-05-07T00:02:00.000Z',
    });
    assert.equal(homepageClaim.listing_id, 'source-home');
  } finally {
    closeMarketplaceHomepageDatabase(db);
  }
});

test('claimNextPendingHomepageListing can filter queue status', () => {
  const dbPath = createTempDbPath();
  const { db } = openMarketplaceHomepageDatabase(dbPath);

  try {
    upsertHomepageListing(db, {
      listingId: 'status-pending',
      href: 'https://www.facebook.com/marketplace/item/801/',
      title: 'Pending row',
      text: 'Pending card',
      rank: 1,
    });
    upsertHomepageListing(db, {
      listingId: 'status-error',
      href: 'https://www.facebook.com/marketplace/item/802/',
      title: 'Error row',
      text: 'Error card',
      rank: 2,
    });

    const errorClaimSeed = claimNextPendingHomepageListing(db, {
      workerId: 'worker-seed',
      statusFilter: 'pending',
      claimedAt: '2026-05-07T00:00:00.000Z',
    });
    assert.equal(errorClaimSeed.listing_id, 'status-pending');
    markHomepageListingFailed(db, 'status-pending', 'temporary failure');

    const pendingClaim = claimNextPendingHomepageListing(db, {
      workerId: 'worker-pending',
      statusFilter: 'pending',
      claimedAt: '2026-05-07T00:01:00.000Z',
    });
    assert.equal(pendingClaim.listing_id, 'status-error');

    const errorClaim = claimNextPendingHomepageListing(db, {
      workerId: 'worker-error',
      statusFilter: 'error',
      retryDelaySeconds: 0,
      claimedAt: '2026-05-07T00:02:00.000Z',
    });
    assert.equal(errorClaim.listing_id, 'status-pending');
  } finally {
    closeMarketplaceHomepageDatabase(db);
  }
});

test('claimNextPendingHomepageListing can start from latest, earliest, and a seen range', () => {
  const dbPath = createTempDbPath();
  const { db } = openMarketplaceHomepageDatabase(dbPath);

  try {
    upsertHomepageListing(db, {
      listingId: 'old-row',
      href: 'https://www.facebook.com/marketplace/item/811/',
      title: 'Old row',
      text: 'Old card',
      rank: 3,
    }, {
      seenAt: '2026-05-07T00:00:00.000Z',
    });
    upsertHomepageListing(db, {
      listingId: 'middle-row',
      href: 'https://www.facebook.com/marketplace/item/812/',
      title: 'Middle row',
      text: 'Middle card',
      rank: 2,
    }, {
      seenAt: '2026-05-07T01:00:00.000Z',
    });
    upsertHomepageListing(db, {
      listingId: 'new-row',
      href: 'https://www.facebook.com/marketplace/item/813/',
      title: 'New row',
      text: 'New card',
      rank: 1,
    }, {
      seenAt: '2026-05-07T02:00:00.000Z',
    });

    const preview = listBacklogCandidates(db, {
      statusFilter: 'pending',
      backlogOrder: 'latest',
      seenTimeField: 'last_seen',
      seenAfter: '2026-05-07T00:30:00.000Z',
      seenBefore: '2026-05-07T02:30:00.000Z',
      limit: 10,
    });
    assert.deepEqual(preview.map((row) => row.listing_id), ['new-row', 'middle-row']);

    const latestClaim = claimNextPendingHomepageListing(db, {
      workerId: 'worker-latest',
      statusFilter: 'pending',
      backlogOrder: 'latest',
      seenTimeField: 'last_seen',
      seenAfter: '2026-05-07T00:30:00.000Z',
      seenBefore: '2026-05-07T02:30:00.000Z',
      claimedAt: '2026-05-07T03:00:00.000Z',
    });
    assert.equal(latestClaim.listing_id, 'new-row');

    const earliestClaim = claimNextPendingHomepageListing(db, {
      workerId: 'worker-earliest',
      statusFilter: 'pending',
      backlogOrder: 'earliest',
      seenTimeField: 'last_seen',
      seenAfter: '2026-05-07T00:30:00.000Z',
      seenBefore: '2026-05-07T02:30:00.000Z',
      claimedAt: '2026-05-07T03:01:00.000Z',
    });
    assert.equal(earliestClaim.listing_id, 'middle-row');
  } finally {
    closeMarketplaceHomepageDatabase(db);
  }
});

test('claimNextPendingHomepageListing can restrict claims to explicit listing ids', () => {
  const dbPath = createTempDbPath();
  const { db } = openMarketplaceHomepageDatabase(dbPath);

  try {
    upsertHomepageListing(db, {
      listingId: 'target-a',
      href: 'https://www.facebook.com/marketplace/item/821/',
      title: 'Target A',
      text: 'Target A card',
      rank: 1,
    });
    upsertHomepageListing(db, {
      listingId: 'target-b',
      href: 'https://www.facebook.com/marketplace/item/822/',
      title: 'Target B',
      text: 'Target B card',
      rank: 2,
    });
    upsertHomepageListing(db, {
      listingId: 'outside',
      href: 'https://www.facebook.com/marketplace/item/823/',
      title: 'Outside',
      text: 'Outside card',
      rank: 0,
    });

    const claimed = claimNextPendingHomepageListing(db, {
      workerId: 'worker-selected',
      statusFilter: 'pending',
      listingIds: ['target-b'],
      claimedAt: '2026-05-07T03:00:00.000Z',
    });
    assert.equal(claimed.listing_id, 'target-b');

    const next = claimNextPendingHomepageListing(db, {
      workerId: 'worker-selected',
      statusFilter: 'pending',
      listingIds: ['target-b'],
      claimedAt: '2026-05-07T03:01:00.000Z',
    });
    assert.equal(next, null);
  } finally {
    closeMarketplaceHomepageDatabase(db);
  }
});

test('inactive listings are counted and only claimed when requested', () => {
  const dbPath = createTempDbPath();
  const { db } = openMarketplaceHomepageDatabase(dbPath);

  try {
    upsertHomepageListing(db, {
      listingId: 'inactive-sold',
      href: 'https://www.facebook.com/marketplace/item/901/',
      title: 'Sold row',
      text: 'Sold card',
      rank: 1,
    });
    markHomepageListingInactive(db, 'inactive-sold', 'sold', {
      title: 'Sold row',
      listingContent: {
        title: 'Sold row',
        availabilityStatus: 'sold',
        availabilityReason: 'sold_signal',
      },
      screenshotPath: '/tmp/sold.png',
      snapshotPath: '/tmp/sold.md',
    }, 'sold_signal');

    const counts = getHomepageListingCounts(db);
    assert.equal(counts.sold, 1);

    const refreshed = upsertHomepageListing(db, {
      listingId: 'inactive-sold',
      href: 'https://www.facebook.com/marketplace/item/901/?ref=feed',
      title: 'Sold row seen again',
      text: 'Sold card seen again',
      rank: 2,
    });
    assert.equal(refreshed.detail_status, 'sold');

    const defaultClaim = claimNextPendingHomepageListing(db, {
      workerId: 'worker-default',
      statusFilter: 'all',
    });
    assert.equal(defaultClaim, null);

    const soldClaim = claimNextPendingHomepageListing(db, {
      workerId: 'worker-sold',
      statusFilter: 'sold',
    });
    assert.equal(soldClaim.listing_id, 'inactive-sold');
  } finally {
    closeMarketplaceHomepageDatabase(db);
  }
});
