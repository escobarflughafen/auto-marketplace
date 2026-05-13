const fs = require('fs');
const os = require('os');
const path = require('path');
const test = require('node:test');
const assert = require('node:assert/strict');

const {
  openMarketplaceHomepageDatabase,
  closeMarketplaceHomepageDatabase,
  upsertHomepageListing,
  appendListingEvent,
  appendWorkflowEvent,
} = require('../scripts/marketplace-homepage-db');
const {
  parseArgs,
  mergeMarketplaceHomepageDb,
  transformJsonText,
  transformMediaPath,
} = require('../scripts/merge-marketplace-homepage-db');

function createTempDbPath(prefix = 'marketplace-merge-') {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  return path.join(tempDir, 'queue.db');
}

function withDb(dbPath, callback) {
  const { db } = openMarketplaceHomepageDatabase(dbPath);
  try {
    return callback(db);
  } finally {
    closeMarketplaceHomepageDatabase(db);
  }
}

function seedListing(db, listingId, overrides = {}) {
  upsertHomepageListing(db, {
    listingId,
    href: `https://www.facebook.com/marketplace/item/${listingId}/`,
    title: overrides.cardTitle || `Card ${listingId}`,
    text: overrides.cardText || `Text ${listingId}`,
    rank: 1,
    source: overrides.source || 'homepage',
  });
  if (overrides.detailStatus) {
    db.prepare(`
      UPDATE homepage_listings
      SET
        detail_status = ?,
        detail_attempts = ?,
        detail_last_error = ?,
        detail_started_at = ?,
        detail_completed_at = ?,
        claimed_by = ?,
        detail_title = ?,
        detail_price = ?,
        detail_location = ?,
        detail_condition = ?,
        detail_listed_ago = ?,
        detail_seller_name = ?,
        detail_json = ?,
        screenshot_path = ?,
        snapshot_path = ?
      WHERE listing_id = ?
    `).run(
      overrides.detailStatus,
      overrides.detailAttempts ?? 1,
      overrides.detailLastError || '',
      overrides.detailStartedAt || '2026-05-01T00:00:00.000Z',
      overrides.detailCompletedAt || '2026-05-01T00:01:00.000Z',
      overrides.claimedBy || '',
      overrides.detailTitle || `Detail ${listingId}`,
      overrides.detailPrice || 'CA$ 100',
      overrides.detailLocation || 'Vancouver, BC',
      overrides.detailCondition || 'Used',
      overrides.detailListedAgo || 'today',
      overrides.detailSellerName || 'Seller',
      JSON.stringify(overrides.detailJson || {
        title: `Detail ${listingId}`,
        screenshotPath: `/Users/aoi/Workspaces/auto-browser/artifacts/${listingId}.png`,
        snapshotPath: `/Users/aoi/Workspaces/auto-browser/artifacts/${listingId}.md`,
        thumbnails: [{ screenshotPath: `/Users/aoi/Workspaces/auto-browser/artifacts/${listingId}-thumb.png` }],
      }),
      overrides.screenshotPath || `/Users/aoi/Workspaces/auto-browser/artifacts/${listingId}.png`,
      overrides.snapshotPath || `/Users/aoi/Workspaces/auto-browser/artifacts/${listingId}.md`,
      listingId,
    );
  }
}

test('parseArgs defaults to dry-run and clearing media paths', () => {
  const options = parseArgs(['--source-db', 'source.db']);

  assert.equal(options.sourceDbPath, 'source.db');
  assert.equal(options.targetDbPath.endsWith('marketplace-homepage.db'), true);
  assert.equal(options.dryRun, true);
  assert.equal(options.clearMediaPaths, true);
  assert.deepEqual(options.statuses, ['done', 'sold', 'pending_sale']);
});

test('media helpers clear or rewrite paths', () => {
  assert.equal(transformMediaPath('/Users/aoi/file.png', { clearMediaPaths: true, rewritePrefixes: [] }), '');
  assert.equal(
    transformMediaPath('/Users/aoi/file.png', {
      clearMediaPaths: false,
      rewritePrefixes: [{ from: '/Users/aoi', to: '/app/local' }],
    }),
    '/app/local/file.png',
  );
  assert.equal(
    transformJsonText(JSON.stringify({
      title: 'Camera',
      screenshotPath: '/Users/aoi/file.png',
      detailHtmlPath: '/Users/aoi/file.html',
      detailFullHtmlPath: '/Users/aoi/file-full.html',
      nested: { snapshotPath: '/Users/aoi/file.md' },
    }), { clearMediaPaths: true, rewritePrefixes: [] }),
    JSON.stringify({ title: 'Camera', screenshotPath: '', detailHtmlPath: '', detailFullHtmlPath: '', nested: { snapshotPath: '' } }),
  );
});

test('dry-run reports resolved listing and event changes without writing', () => {
  const sourceDbPath = createTempDbPath();
  const targetDbPath = createTempDbPath();

  withDb(sourceDbPath, (db) => {
    seedListing(db, 'merge-1', { detailStatus: 'done', detailTitle: 'Resolved title' });
    appendListingEvent(db, {
      eventId: 'event-merge-1',
      listingId: 'merge-1',
      eventType: 'detail_capture_succeeded',
      eventAt: '2026-05-01T00:02:00.000Z',
      status: 'done',
      content: { artifacts: { screenshotPath: '/Users/aoi/shot.png' } },
      screenshotPath: '/Users/aoi/shot.png',
    });
    appendWorkflowEvent(db, {
      eventId: 'workflow-event-1',
      workflowRunId: 'worker-local',
      eventType: 'session_ready',
      eventAt: '2026-05-01T00:00:00.000Z',
      status: 'authenticated',
      content: { ok: true },
    });
  });
  withDb(targetDbPath, (db) => {
    seedListing(db, 'merge-1', { detailStatus: 'pending' });
  });

  const result = mergeMarketplaceHomepageDb({
    ...parseArgs(['--source-db', sourceDbPath, '--target-db', targetDbPath]),
    dryRun: true,
  });

  assert.equal(result.summary.resolvedListings.updated, 1);
  assert.equal(result.summary.listingEvents.inserted, 1);
  assert.equal(result.summary.workflowEvents.inserted, 1);

  withDb(targetDbPath, (db) => {
    const listing = db.prepare('SELECT detail_status, detail_title FROM homepage_listings WHERE listing_id = ?').get('merge-1');
    assert.equal(listing.detail_status, 'pending');
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM listing_events').get().count, 0);
  });
});

test('execute merges terminal detail rows and event history with media scrubbed', () => {
  const sourceDbPath = createTempDbPath();
  const targetDbPath = createTempDbPath();

  withDb(sourceDbPath, (db) => {
    seedListing(db, 'merge-2', {
      detailStatus: 'done',
      detailCompletedAt: '2026-05-02T00:00:00.000Z',
      detailTitle: 'New detail title',
      claimedBy: 'local-worker',
    });
    seedListing(db, 'merge-3', { detailStatus: 'error' });
    appendListingEvent(db, {
      eventId: 'event-merge-2',
      listingId: 'merge-2',
      eventType: 'detail_capture_succeeded',
      eventAt: '2026-05-02T00:02:00.000Z',
      status: 'done',
      content: { artifacts: { screenshotPath: '/Users/aoi/shot.png' } },
      screenshotPath: '/Users/aoi/shot.png',
      snapshotPath: '/Users/aoi/shot.md',
    });
  });
  withDb(targetDbPath, (db) => {
    seedListing(db, 'merge-2', {
      detailStatus: 'done',
      detailCompletedAt: '2026-05-01T00:00:00.000Z',
      detailTitle: 'Old detail title',
    });
  });

  const result = mergeMarketplaceHomepageDb({
    ...parseArgs(['--source-db', sourceDbPath, '--target-db', targetDbPath, '--execute']),
  });

  assert.equal(result.dryRun, false);
  assert.equal(result.summary.resolvedListings.updated, 1);
  assert.equal(result.summary.listingEvents.inserted, 1);

  withDb(targetDbPath, (db) => {
    const listing = db.prepare(`
      SELECT detail_status, detail_title, claimed_by, screenshot_path, snapshot_path, detail_json
      FROM homepage_listings
      WHERE listing_id = ?
    `).get('merge-2');
    assert.equal(listing.detail_status, 'done');
    assert.equal(listing.detail_title, 'New detail title');
    assert.equal(listing.claimed_by, '');
    assert.equal(listing.screenshot_path, '');
    assert.equal(listing.snapshot_path, '');
    assert.equal(JSON.parse(listing.detail_json).screenshotPath, '');

    const event = db.prepare('SELECT screenshot_path, snapshot_path, content_json FROM listing_events WHERE event_id = ?').get('event-merge-2');
    assert.equal(event.screenshot_path, '');
    assert.equal(event.snapshot_path, '');
    assert.equal(JSON.parse(event.content_json).artifacts.screenshotPath, '');
  });
});

test('execute skips target terminal rows that are newer than source', () => {
  const sourceDbPath = createTempDbPath();
  const targetDbPath = createTempDbPath();

  withDb(sourceDbPath, (db) => {
    seedListing(db, 'merge-4', {
      detailStatus: 'done',
      detailCompletedAt: '2026-05-01T00:00:00.000Z',
      detailTitle: 'Older source',
    });
  });
  withDb(targetDbPath, (db) => {
    seedListing(db, 'merge-4', {
      detailStatus: 'done',
      detailCompletedAt: '2026-05-03T00:00:00.000Z',
      detailTitle: 'Newer target',
    });
  });

  const result = mergeMarketplaceHomepageDb({
    ...parseArgs(['--source-db', sourceDbPath, '--target-db', targetDbPath, '--execute']),
  });

  assert.equal(result.summary.resolvedListings.skippedTerminalNewerOrEqual, 1);
  withDb(targetDbPath, (db) => {
    assert.equal(
      db.prepare('SELECT detail_title FROM homepage_listings WHERE listing_id = ?').get('merge-4').detail_title,
      'Newer target',
    );
  });
});
