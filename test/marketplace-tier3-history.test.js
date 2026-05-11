const test = require('node:test');
const assert = require('node:assert/strict');

const {
  parseCsv,
  deriveHistoryProfileFromRows,
  scoreVerdict,
} = require('../scripts/marketplace-tier3-verdict-dry-run');

test('parseCsv handles quoted commas and escaped quotes', () => {
  const rows = parseCsv([
    'record_id,title,notes',
    't1,"Leica M6, black","seller said ""clean finder"""',
  ].join('\n'));

  assert.deepEqual(rows, [{
    record_id: 't1',
    title: 'Leica M6, black',
    notes: 'seller said "clean finder"',
  }]);
});

test('deriveHistoryProfileFromRows builds preferences and price bands from CSV rows', () => {
  const profile = deriveHistoryProfileFromRows([
    {
      category: 'camera_gear',
      brand: 'leica',
      model: 'm6',
      decision: 'sold',
      outcome: 'sold_profitable',
      purchase_price_cad: '2400',
      sold_price_cad: '3100',
      realized_profit_cad: '420',
      issue_flags: '',
    },
    {
      category: 'camera_gear',
      brand: 'nikon',
      model: 'fm2',
      decision: 'skipped',
      outcome: 'condition_problem',
      purchase_price_cad: '300',
      realized_profit_cad: '-50',
      issue_flags: 'fungus|not tested',
    },
  ]);

  assert.equal(profile.source, 'csv');
  assert.equal(profile.rowCount, 2);
  assert.deepEqual(profile.preferredCategories, ['camera_gear']);
  assert.deepEqual(profile.preferredBrands, ['leica']);
  assert.equal(profile.priceBands.camera_gear.targetMax >= 2400, true);
  assert.equal(profile.avoidKeywords.includes('fungus'), true);
  assert.equal(profile.avoidKeywords.includes('not tested'), true);
});

test('scoreVerdict reports CSV history profile usage', () => {
  const profile = deriveHistoryProfileFromRows([{
    category: 'camera_gear',
    brand: 'leica',
    decision: 'sold',
    outcome: 'sold_profitable',
    purchase_price_cad: '2500',
    realized_profit_cad: '500',
  }]);
  const verdict = scoreVerdict({
    listingId: '1',
    artifactPath: 'details/1.md',
    pageText: 'Marketplace Leica M6 CA$ 2,600 Vancouver, BC',
    listingContent: {
      title: 'Leica M6',
      description: 'Clean Leica M6 body.',
      price: 'CA$ 2,600',
      condition: 'Used - good',
      location: 'Vancouver, BC',
      availabilityStatus: 'available',
      availabilityReason: 'available_marker',
    },
  }, profile);

  assert.equal(verdict.reasonCodes.includes('using_csv_history_profile'), true);
  assert.equal(verdict.scores.historyMatch, 0.95);
});
