const fs = require('fs');
const os = require('os');
const path = require('path');
const test = require('node:test');
const assert = require('node:assert/strict');

const {
  parseArgs,
  extractModuleExports,
  classifyExport,
  buildInventory,
} = require('../scripts/postgres-cutover-inventory');

test('parseArgs reads inventory options', () => {
  assert.deepEqual(parseArgs(['--db-module', '/tmp/db.js', '--json', '--strict']), {
    dbModule: '/tmp/db.js',
    json: true,
    strict: true,
  });
});

test('extractModuleExports reads the exported helper list', () => {
  const exports = extractModuleExports(`
function a() {}
module.exports = {
  DEFAULT_DB_PATH,
  getHomepageListing,
  upsertHomepageListing,
  aliased: localValue,
};
`);
  assert.deepEqual(exports, ['DEFAULT_DB_PATH', 'getHomepageListing', 'upsertHomepageListing', 'aliased']);
});

test('classifyExport separates pure, read, write, transaction, and runtime boundaries', () => {
  assert.equal(classifyExport('DEFAULT_DB_PATH'), 'pure');
  assert.equal(classifyExport('getHomepageListing'), 'read');
  assert.equal(classifyExport('listWorkflowRuns'), 'read');
  assert.equal(classifyExport('upsertHomepageListing'), 'write');
  assert.equal(classifyExport('claimNextPendingHomepageListing'), 'write');
  assert.equal(classifyExport('setSavedQueryOverview'), 'write');
  assert.equal(classifyExport('appendListingEvent'), 'write');
  assert.equal(classifyExport('runTransaction'), 'transaction');
  assert.equal(classifyExport('openMarketplaceHomepageDatabase'), 'runtime');
});

test('buildInventory reports required cutover gaps from a DB helper module', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'postgres-cutover-inventory-'));
  const dbModule = path.join(tempDir, 'marketplace-homepage-db.js');
  fs.writeFileSync(dbModule, `
module.exports = {
  DEFAULT_DB_PATH,
  resolveDbPath,
  getHomepageListing,
  listWorkflowRuns,
  upsertHomepageListing,
  appendListingEvent,
  runTransaction,
  openMarketplaceHomepageDatabase,
};
`);
  const inventory = buildInventory({ dbModule });

  assert.equal(inventory.ok, false);
  assert.equal(inventory.counts.total, 8);
  assert.equal(inventory.counts.covered, 6);
  assert.equal(inventory.counts.gaps, 2);
  assert.deepEqual(inventory.nextRequiredGaps, [
    'runTransaction',
    'openMarketplaceHomepageDatabase',
  ]);
});

test('buildInventory against current DB module records existing cutover gaps', () => {
  const inventory = buildInventory({ dbModule: path.join(process.cwd(), 'scripts', 'marketplace-homepage-db.js') });

  assert.equal(inventory.ok, false);
  assert.ok(inventory.counts.total > 50);
  assert.ok(inventory.counts.gaps > 5);
  assert.ok(inventory.nextRequiredGaps.includes('openMarketplaceHomepageDatabase'));
  assert.ok(!inventory.nextRequiredGaps.includes('upsertHomepageListing'));
  assert.ok(!inventory.nextRequiredGaps.includes('appendListingEvent'));
});
