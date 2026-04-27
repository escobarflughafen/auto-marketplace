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
  upsertHomepageListingWithStatus,
  upsertHomepageListing,
  claimNextPendingHomepageListing,
  markHomepageListingProcessed,
  markHomepageListingFailed,
  getHomepageListingCounts,
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
