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
    '--dry-run',
    '--json',
  ]);

  assert.equal(options.dbPath, 'tmp/home.db');
  assert.equal(options.checkpoint, false);
  assert.equal(options.optimize, false);
  assert.equal(options.analyze, true);
  assert.equal(options.vacuum, true);
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
