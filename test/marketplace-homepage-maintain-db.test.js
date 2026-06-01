const test = require('node:test');
const assert = require('node:assert/strict');

const {
  parseArgs,
  renderReport,
} = require('../scripts/marketplace-homepage-maintain-db');

test('parseArgs reads maintenance flags', () => {
  const options = parseArgs([
    '--db-path', 'tmp/home.db',
    '--no-checkpoint',
    '--no-optimize',
    '--analyze',
    '--vacuum',
    '--normalize-listed-at',
    '--normalize-listed-at-limit', '25',
    '--recover-stale-processing',
    '--stale-processing-seconds', '900',
    '--stale-processing-limit', '10',
    '--stale-processing-status', 'error',
    '--stale-processing-reason', 'test recovery',
    '--dry-run',
    '--json',
  ]);

  assert.equal(options.dbPath, 'tmp/home.db');
  assert.equal(options.checkpoint, false);
  assert.equal(options.optimize, false);
  assert.equal(options.analyze, true);
  assert.equal(options.vacuum, true);
  assert.equal(options.normalizeListedAt, true);
  assert.equal(options.normalizeListedAtLimit, 25);
  assert.equal(options.recoverStaleProcessing, true);
  assert.equal(options.staleProcessingSeconds, 900);
  assert.equal(options.staleProcessingLimit, 10);
  assert.equal(options.staleProcessingStatus, 'error');
  assert.equal(options.staleProcessingReason, 'test recovery');
  assert.equal(options.dryRun, true);
  assert.equal(options.json, true);
});

test('renderReport includes row and file summary', () => {
  const text = renderReport({
    dbPath: '/tmp/home.db',
    journalMode: 'wal',
    pageCount: 10,
    pageSize: 4096,
    freelistCount: 0,
    files: {
      dbBytes: 40960,
      walBytes: 1024,
      shmBytes: 32768,
    },
    rows: {
      homepageListings: 5,
      listingEvents: 2,
      workflowRuns: 1,
    },
  });

  assert.match(text, /listings=5/);
  assert.match(text, /wal=1\.0 KB/);
});

test('renderReport includes stale processing dry-run summary', () => {
  const text = renderReport({
    dbPath: '/tmp/home.db',
    journalMode: 'wal',
    pageCount: 10,
    pageSize: 4096,
    freelistCount: 0,
    files: {
      dbBytes: 40960,
      walBytes: 1024,
      shmBytes: 32768,
    },
    rows: {
      homepageListings: 5,
      listingEvents: 2,
      workflowRuns: 1,
    },
    staleProcessing: {
      scanned: 1,
      recovered: 0,
      items: [{
        listing_id: 'stale-1',
        detail_status: 'processing',
        detail_started_at: '2026-05-11T01:00:00.000Z',
        claimed_by: 'worker-1',
      }],
    },
  });

  assert.match(text, /Stale processing: scanned=1 recovered=0/);
  assert.match(text, /stale-1/);
});
