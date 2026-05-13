const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  parseArgs,
  buildDetailEventContent,
  buildJobCardEventContent,
  contentHashForDetailEvent,
  buildClaimOptions,
  computeJitteredPollMs,
  shouldDelayBetweenItems,
  isFatalBrowserContextError,
  safeWorkerPathSegment,
  captureListingScreenshot,
  workerScreenshotDirectory,
  pruneWorkerScreenshots,
} = require('../scripts/process-marketplace-homepage-backlog');

test('parseArgs enables drain mode for backlog resolution', () => {
  const options = parseArgs([
    '--drain',
    '--batch-size', '5',
    '--limit', '25',
    '--source-filter', 'search',
    '--keyword-filter', 'pentax',
    '--max-attempts', '3',
    '--retry-delay-seconds', '60',
    '--status-filter', 'pending',
    '--backlog-order', 'latest',
    '--seen-time-field', 'last_seen',
    '--seen-after', '2026-05-10T00:00:00.000Z',
    '--seen-before', '2026-05-10T01:00:00.000Z',
    '--item-delay-seconds', '7.5',
    '--item-jitter-min', '0.5',
    '--item-jitter-max', '1.5',
    '--resolve-inactive',
    '--use-credentials',
    '--credentials-path', 'tmp/creds.json',
    '--credentials-profile', 'agent-account',
    '--login-timeout-seconds', '45',
    '--worker-screenshot-dir', 'tmp/screens',
    '--worker-screenshot-interval-seconds', '10',
    '--worker-screenshot-history-limit', '100',
    '--screenshot-format', 'jpg',
    '--screenshot-quality', '60',
    '--screenshot-full-page',
    '--artifact-budget-kb', '180',
    '--capture-thumbnails',
  ]);

  assert.equal(options.drain, true);
  assert.equal(options.once, false);
  assert.equal(options.batchSize, 5);
  assert.equal(options.limit, 25);
  assert.equal(options.sourceFilter, 'search');
  assert.equal(options.keywordFilter, 'pentax');
  assert.equal(options.maxAttempts, 3);
  assert.equal(options.retryDelaySeconds, 60);
  assert.equal(options.statusFilter, 'pending');
  assert.equal(options.backlogOrder, 'latest');
  assert.equal(options.seenTimeField, 'last_seen');
  assert.equal(options.seenAfter, '2026-05-10T00:00:00.000Z');
  assert.equal(options.seenBefore, '2026-05-10T01:00:00.000Z');
  assert.equal(options.itemDelaySeconds, 7.5);
  assert.equal(options.itemJitterMin, 0.5);
  assert.equal(options.itemJitterMax, 1.5);
  assert.equal(options.resolveInactive, true);
  assert.equal(options.useCredentials, true);
  assert.equal(options.authMode, 'credentials');
  assert.equal(options.credentialsPath, 'tmp/creds.json');
  assert.equal(options.credentialsProfile, 'agent-account');
  assert.equal(options.loginTimeoutMs, 45000);
  assert.equal(options.workerScreenshotDir, 'tmp/screens');
  assert.equal(options.workerScreenshotIntervalSeconds, 10);
  assert.equal(options.workerScreenshotHistoryLimit, 100);
  assert.equal(options.screenshotFormat, 'jpeg');
  assert.equal(options.screenshotQuality, 60);
  assert.equal(options.screenshotFullPage, true);
  assert.equal(options.artifactBudgetKb, 180);
  assert.equal(options.captureThumbnails, true);
});

test('parseArgs defaults to storage-saving listing screenshots', () => {
  const options = parseArgs(['--once']);

  assert.equal(options.screenshotFormat, 'jpeg');
  assert.equal(options.screenshotQuality, 55);
  assert.equal(options.screenshotFullPage, false);
  assert.equal(options.artifactBudgetKb, 200);
  assert.equal(options.captureThumbnails, false);
});

test('captureListingScreenshot lowers JPEG quality to fit the artifact budget', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'marketplace-listing-shot-'));
  const screenshotPath = path.join(tempDir, 'listing.jpg');
  const calls = [];
  const page = {
    async screenshot(options) {
      calls.push(options);
      const size = options.quality === 55 ? 250 * 1024 : 150 * 1024;
      return Buffer.alloc(size, options.quality);
    },
  };

  const result = await captureListingScreenshot(page, screenshotPath, {
    screenshotFormat: 'jpeg',
    screenshotQuality: 55,
    screenshotFullPage: false,
    artifactBudgetKb: 200,
  });

  assert.equal(result.format, 'jpeg');
  assert.equal(result.quality, 45);
  assert.equal(result.withinBudget, true);
  assert.equal(fs.statSync(screenshotPath).size, 150 * 1024);
  assert.deepEqual(calls.map((call) => call.quality), [55, 45]);
});

test('worker screenshot directory uses safe worker path segment', () => {
  const options = parseArgs([
    '--worker-id', 'backlog worker / 1',
    '--worker-screenshot-dir', 'tmp/screens',
  ]);

  assert.equal(safeWorkerPathSegment(options.workerId), 'backlog-worker-1');
  assert.equal(workerScreenshotDirectory(options), path.join(process.cwd(), 'tmp/screens/backlog-worker-1'));
});

test('pruneWorkerScreenshots keeps newest screenshots', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'marketplace-worker-shots-'));
  const files = ['old.png', 'middle.png', 'new.png'];
  for (const [index, name] of files.entries()) {
    const filePath = path.join(tempDir, name);
    fs.writeFileSync(filePath, name, 'utf8');
    const time = new Date(Date.UTC(2026, 4, 12, 0, 0, index));
    fs.utimesSync(filePath, time, time);
  }

  await pruneWorkerScreenshots(tempDir, 2);

  assert.deepEqual(fs.readdirSync(tempDir).sort(), ['middle.png', 'new.png']);
});

test('parseArgs supports unauthenticated backlog processing', () => {
  const options = parseArgs(['--auth-mode', 'none', '--once']);

  assert.equal(options.authMode, 'none');
  assert.equal(options.useCredentials, false);
});

test('parseArgs rejects once and drain together', () => {
  assert.throws(
    () => parseArgs(['--once', '--drain']),
    /Use either --once or --drain/,
  );
});

test('computeJitteredPollMs respects fixed multiplier', () => {
  const result = computeJitteredPollMs(15, 1, 1);
  assert.equal(result.waitMs, 15000);
  assert.equal(result.multiplier, 1);
});

test('parseArgs rejects invalid item jitter range', () => {
  assert.throws(
    () => parseArgs(['--item-jitter-min', '2', '--item-jitter-max', '1']),
    /Expected --item-jitter-max/,
  );
});

test('parseArgs rejects invalid backlog start controls', () => {
  assert.throws(
    () => parseArgs(['--backlog-order', 'random']),
    /Expected --backlog-order/,
  );
  assert.throws(
    () => parseArgs(['--seen-time-field', 'updated_at']),
    /Expected --seen-time-field/,
  );
  assert.throws(
    () => parseArgs(['--seen-after', '2026-05-11', '--seen-before', '2026-05-10']),
    /Expected --seen-before/,
  );
});

test('parseArgs reads listing ids from flags and batch files', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'marketplace-backlog-ids-'));
  const filePath = path.join(tempDir, 'ids.json');
  fs.writeFileSync(filePath, JSON.stringify({
    listingIds: ['file-a', 'file-b', 'file-a'],
  }), 'utf8');

  const options = parseArgs([
    '--listing-id', 'flag-a',
    '--listing-ids', 'flag-b,flag-c',
    '--listing-id-file', filePath,
  ]);

  assert.deepEqual(options.listingIds, ['flag-a', 'flag-b', 'flag-c', 'file-a', 'file-b']);
  assert.equal(options.listingIdFile, filePath);
});

test('buildClaimOptions preserves selected listing temp table', () => {
  const options = parseArgs(['--listing-id', 'target-a']);
  options.listingIdTable = 'selected_resolve_listing_ids';
  options.listingIds = [];

  assert.equal(buildClaimOptions(options).listingIdTable, 'selected_resolve_listing_ids');
});

test('shouldDelayBetweenItems skips once mode and exhausted limits', () => {
  assert.equal(shouldDelayBetweenItems(
    { itemDelaySeconds: 8, once: false, limit: 0 },
    { attemptedCount: 1 },
    Infinity,
  ), true);
  assert.equal(shouldDelayBetweenItems(
    { itemDelaySeconds: 8, once: true, limit: 0 },
    { attemptedCount: 1 },
    Infinity,
  ), false);
  assert.equal(shouldDelayBetweenItems(
    { itemDelaySeconds: 8, once: false, limit: 5 },
    { attemptedCount: 1 },
    0,
  ), false);
});

test('buildDetailEventContent captures structured resolver metadata', () => {
  const listing = {
    listing_id: 'listing-1',
    href: 'https://www.facebook.com/marketplace/item/1/',
    card_title: 'Card title',
    card_text: 'CA$ 100 | Card title | Ottawa',
    source: 'search',
    source_keyword: 'camera',
    first_seen_at: '2026-05-10T00:00:00.000Z',
    last_seen_at: '2026-05-10T00:05:00.000Z',
    last_seen_rank: 3,
    detail_status: 'processing',
    detail_attempts: 2,
  };
  const detailRecord = {
    title: 'Detail title',
    screenshotPath: '/tmp/listing-1.png',
    snapshotPath: '/tmp/listing-1.md',
    detailHtmlPath: '/tmp/listing-1.html',
    detailFullHtmlPath: '/tmp/listing-1-full.html',
    detailHtml: {
      path: '/tmp/listing-1.html',
      selector: 'div',
      xpath: '/html[1]/body[1]/div[1]',
      htmlLength: 1200,
      textLength: 120,
      score: 30,
    },
    detailFullHtml: {
      path: '/tmp/listing-1-full.html',
      selector: 'div[role="main"]',
      xpath: '/html[1]/body[1]/div[2]',
      htmlLength: 4200,
      textLength: 320,
      score: 32,
    },
    thumbnails: [{ screenshotPath: '/tmp/thumb-1.png', src: 'https://example.test/thumb.jpg' }],
    listingContent: {
      title: 'Detail title',
      price: 'CA$ 100',
      previousPrice: 'CA$ 125',
      location: 'Ottawa, ON',
      condition: 'Used - Good condition',
      listedAgo: '12 minutes ago',
      sellerName: 'Seller A',
      sellerRating: '4',
      sellerJoined: '2020',
      availabilityStatus: 'available',
      availabilityReason: 'available_signal',
      description: 'Clean camera.',
      rawText: 'Detail title CA$ 100 12 minutes ago Ottawa, ON',
    },
  };

  const content = buildDetailEventContent(listing, detailRecord, 'worker-1');

  assert.equal(content.detail.previousPrice, 'CA$ 125');
  assert.equal(content.detail.sellerRating, '4');
  assert.equal(content.detail.sellerJoined, '2020');
  assert.equal(content.card.detailStatusBeforeCapture, 'processing');
  assert.equal(content.freshness.sourceLastSeenRank, 3);
  assert.equal(content.availability.isAvailable, true);
  assert.equal(content.availability.isInactive, false);
  assert.equal(content.extraction.thumbnailCount, 1);
  assert.equal(content.extraction.extractedFields.screenshot, true);
  assert.equal(content.extraction.extractedFields.detailHtml, true);
  assert.equal(content.extraction.extractedFields.detailFullHtml, true);
  assert.equal(content.artifacts.detailHtmlPath, '/tmp/listing-1.html');
  assert.equal(content.artifacts.detailFullHtmlPath, '/tmp/listing-1-full.html');
  assert.equal(content.artifacts.detailHtml.htmlLength, 1200);
  assert.equal(content.artifacts.detailFullHtml.htmlLength, 4200);
  assert.equal(content.runtime.contentHashStrategy, 'comparable.detail.v1');
});

test('contentHashForDetailEvent ignores volatile raw text and listed age', () => {
  const listing = {
    listing_id: 'listing-2',
    href: 'https://www.facebook.com/marketplace/item/2/',
    card_title: 'Card title',
    card_text: '',
    source: 'homepage',
    source_keyword: '',
    first_seen_at: '2026-05-10T00:00:00.000Z',
    last_seen_at: '2026-05-10T00:05:00.000Z',
    last_seen_rank: 1,
    detail_status: 'processing',
    detail_attempts: 1,
  };
  const baseRecord = {
    title: 'Detail title',
    screenshotPath: '/tmp/listing-2.png',
    snapshotPath: '/tmp/listing-2.md',
    thumbnails: [],
    listingContent: {
      title: 'Detail title',
      price: 'CA$ 100',
      location: 'Ottawa, ON',
      condition: 'Used - Good condition',
      listedAgo: '12 minutes ago',
      sellerName: 'Seller A',
      availabilityStatus: 'available',
      availabilityReason: 'available_signal',
      description: 'Clean camera.',
      rawText: 'Detail title CA$ 100 12 minutes ago',
    },
  };
  const laterRecord = {
    ...baseRecord,
    listingContent: {
      ...baseRecord.listingContent,
      listedAgo: '15 minutes ago',
      rawText: 'Detail title CA$ 100 15 minutes ago',
    },
  };

  const firstHash = contentHashForDetailEvent(buildDetailEventContent(listing, baseRecord, 'worker-1'));
  const secondHash = contentHashForDetailEvent(buildDetailEventContent(listing, laterRecord, 'worker-1'));
  assert.equal(firstHash, secondHash);
});

test('buildJobCardEventContent includes source and attempt context', () => {
  const content = buildJobCardEventContent({
    listing_id: 'listing-3',
    href: 'https://www.facebook.com/marketplace/item/3/',
    card_title: 'Card title',
    card_text: 'Card text',
    source: 'search',
    source_keyword: 'nikon',
    first_seen_at: '2026-05-10T00:00:00.000Z',
    last_seen_at: '2026-05-10T00:05:00.000Z',
    last_seen_rank: 2,
    detail_status: 'processing',
    detail_attempts: 4,
  }, 'worker-2', {
    error: { type: 'TEST', message: 'failed' },
  });

  assert.equal(content.card.source, 'search');
  assert.equal(content.card.sourceKeyword, 'nikon');
  assert.equal(content.card.attemptsBeforeCapture, 4);
  assert.equal(content.runtime.workerId, 'worker-2');
  assert.equal(content.error.message, 'failed');
});

test('isFatalBrowserContextError classifies closed browser failures', () => {
  assert.equal(
    isFatalBrowserContextError(new Error('browserContext.newPage: Target page, context or browser has been closed')),
    true,
  );
  assert.equal(
    isFatalBrowserContextError(new Error('page.screenshot: Target page, context or browser has been closed')),
    true,
  );
  assert.equal(
    isFatalBrowserContextError(new Error('Timeout 30000ms exceeded while waiting for selector')),
    false,
  );
});
