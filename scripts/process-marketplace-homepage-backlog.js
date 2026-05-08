const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');
const {
  createLogger,
  ensureDir,
  safeGoto,
  waitForListingPage,
  expandMarketplaceListingDetails,
  captureListingThumbnails,
  cleanText,
  readListingTitle,
  extractListingContent,
  writeListingSnapshot,
  slugify,
} = require('./marketplace-utils');
const {
  DEFAULT_DB_PATH,
  openMarketplaceHomepageDatabase,
  closeMarketplaceHomepageDatabase,
  claimNextPendingHomepageListing,
  markHomepageListingProcessed,
  markHomepageListingFailed,
  getHomepageListingCounts,
  hashContent,
  appendListingEvent,
  getLatestListingEvent,
} = require('./marketplace-homepage-db');
const {
  describeFacebookMarketplaceSession,
} = require('./marketplace-profile-auth');

const log = createLogger('process-marketplace-homepage-backlog');

function readFlagValue(argv, index, flagName) {
  const value = argv[index + 1];
  if (!value || value.startsWith('--')) {
    throw new Error(`Missing value for ${flagName}`);
  }

  return value;
}

function parseIntegerFlag(value, flagName, minimum = 0) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed < minimum) {
    throw new Error(`Expected ${flagName} to be an integer >= ${minimum}`);
  }

  return parsed;
}

function parseFloatFlag(value, flagName, minimum = 0) {
  const parsed = Number.parseFloat(value);
  if (!Number.isFinite(parsed) || parsed < minimum) {
    throw new Error(`Expected ${flagName} to be a number >= ${minimum}`);
  }

  return parsed;
}

function parseArgs(argv) {
  const options = {
    dbPath: DEFAULT_DB_PATH,
    userDataDir: path.join(process.cwd(), 'profiles', 'facebook-marketplace'),
    captureDir: path.join(process.cwd(), 'artifacts', 'marketplace-homepage', 'details'),
    logFile: path.join(process.cwd(), 'artifacts', 'marketplace-homepage', 'homepage-backlog.log'),
    pollIntervalSeconds: 15,
    pollJitterMin: 1,
    pollJitterMax: 1,
    staleAfterSeconds: 30 * 60,
    retryDelaySeconds: 5 * 60,
    maxAttempts: 5,
    batchSize: 3,
    limit: 0,
    sourceFilter: '',
    keywordFilter: '',
    workerId: `pid-${process.pid}`,
    once: false,
    headless: true,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    switch (arg) {
      case '--db-path':
        options.dbPath = readFlagValue(argv, index, arg);
        index += 1;
        break;
      case '--user-data-dir':
        options.userDataDir = readFlagValue(argv, index, arg);
        index += 1;
        break;
      case '--capture-dir':
        options.captureDir = readFlagValue(argv, index, arg);
        index += 1;
        break;
      case '--log-file':
        options.logFile = readFlagValue(argv, index, arg);
        index += 1;
        break;
      case '--poll-interval-seconds':
        options.pollIntervalSeconds = parseIntegerFlag(readFlagValue(argv, index, arg), arg, 1);
        index += 1;
        break;
      case '--poll-jitter-min':
        options.pollJitterMin = parseFloatFlag(readFlagValue(argv, index, arg), arg, 0);
        index += 1;
        break;
      case '--poll-jitter-max':
        options.pollJitterMax = parseFloatFlag(readFlagValue(argv, index, arg), arg, 0);
        index += 1;
        break;
      case '--stale-after-seconds':
        options.staleAfterSeconds = parseIntegerFlag(readFlagValue(argv, index, arg), arg, 1);
        index += 1;
        break;
      case '--retry-delay-seconds':
        options.retryDelaySeconds = parseIntegerFlag(readFlagValue(argv, index, arg), arg, 0);
        index += 1;
        break;
      case '--max-attempts':
        options.maxAttempts = parseIntegerFlag(readFlagValue(argv, index, arg), arg, 1);
        index += 1;
        break;
      case '--batch-size':
        options.batchSize = parseIntegerFlag(readFlagValue(argv, index, arg), arg, 1);
        index += 1;
        break;
      case '--limit':
        options.limit = parseIntegerFlag(readFlagValue(argv, index, arg), arg, 0);
        index += 1;
        break;
      case '--source-filter':
        options.sourceFilter = readFlagValue(argv, index, arg);
        index += 1;
        break;
      case '--keyword-filter':
        options.keywordFilter = readFlagValue(argv, index, arg);
        index += 1;
        break;
      case '--worker-id':
        options.workerId = readFlagValue(argv, index, arg);
        index += 1;
        break;
      case '--once':
        options.once = true;
        break;
      case '--headed':
        options.headless = false;
        break;
      case '--headless':
        options.headless = true;
        break;
      default:
        throw new Error(`Unknown argument: ${arg}`);
    }
  }

  if (options.pollJitterMax < options.pollJitterMin) {
    throw new Error('Expected --poll-jitter-max to be >= --poll-jitter-min');
  }

  return options;
}

async function appendLog(logFile, message) {
  const line = `[${new Date().toISOString()}] ${message}\n`;
  process.stdout.write(line);
  await ensureDir(path.dirname(logFile));
  await fs.promises.appendFile(logFile, line, 'utf8');
}

async function captureListingRecord(context, page, listing, captureDir) {
  const activePage = await safeGoto(context, page, listing.href);
  await waitForListingPage(activePage);
  await expandMarketplaceListingDetails(activePage, { logger: log });

  const pageText = cleanText(await activePage.locator('body').innerText().catch(() => ''));
  if (/content isn't available|listing isn't available|item isn't available|this content isn't available|此内容目前无法查看|商品不可用/i.test(pageText)) {
    const error = new Error('Listing page appears unavailable');
    error.code = 'LISTING_UNAVAILABLE';
    throw error;
  }

  const listingContent = extractListingContent(pageText, listing.card_title || listing.card_text || listing.listing_id);
  const title = await readListingTitle(activePage, pageText, listingContent.title || listing.card_title || listing.listing_id);
  const baseName = `${listing.listing_id}-${slugify(title)}`;
  const screenshotPath = path.join(captureDir, `${baseName}.png`);

  await activePage.screenshot({ path: screenshotPath, fullPage: true });
  const thumbnails = await captureListingThumbnails(activePage, captureDir, baseName, { logger: log });
  const snapshotPath = await writeListingSnapshot({
    captureDir,
    baseName,
    url: listing.href,
    screenshotPath,
    listingContent,
    thumbnails,
  });

  return {
    page: activePage,
    detailRecord: {
      title,
      listingContent,
      thumbnails,
      screenshotPath,
      snapshotPath,
    },
  };
}

function buildDetailEventContent(listing, detailRecord, workerId) {
  const listingContent = detailRecord.listingContent || {};
  return {
    listingId: listing.listing_id,
    href: listing.href,
    card: {
      title: listing.card_title || '',
      text: listing.card_text || '',
      source: listing.source || '',
      sourceKeyword: listing.source_keyword || '',
      firstSeenAt: listing.first_seen_at || '',
      lastSeenAt: listing.last_seen_at || '',
      lastSeenRank: listing.last_seen_rank ?? null,
    },
    detail: {
      title: detailRecord.title || listingContent.title || '',
      price: listingContent.price || '',
      location: listingContent.location || '',
      condition: listingContent.condition || '',
      listedAgo: listingContent.listedAgo || '',
      sellerName: listingContent.sellerName || '',
      description: listingContent.description || '',
      rawText: listingContent.rawText || '',
    },
    artifacts: {
      screenshotPath: detailRecord.screenshotPath || '',
      snapshotPath: detailRecord.snapshotPath || '',
      thumbnails: detailRecord.thumbnails || [],
    },
    runtime: {
      workerId,
      attempt: listing.detail_attempts,
      capturedAt: new Date().toISOString(),
    },
  };
}

async function processBatch(page, db, options, state = {}) {
  let activePage = page;
  let processedCount = 0;
  let attemptedCount = 0;
  const remainingLimit = Number.isFinite(state.remainingLimit) ? state.remainingLimit : Infinity;
  const batchLimit = Math.min(options.batchSize, remainingLimit);

  for (let index = 0; index < batchLimit; index += 1) {
    const listing = claimNextPendingHomepageListing(db, {
      workerId: options.workerId,
      staleAfterSeconds: options.staleAfterSeconds,
      retryDelaySeconds: options.retryDelaySeconds,
      maxAttempts: options.maxAttempts,
      sourceFilter: options.sourceFilter,
      keywordFilter: options.keywordFilter,
    });

    if (!listing) {
      break;
    }

    await appendLog(
      options.logFile,
      `job_start listing_id=${listing.listing_id} href=${listing.href} attempt=${listing.detail_attempts}`,
    );
    attemptedCount += 1;
    appendListingEvent(db, {
      listingId: listing.listing_id,
      eventType: 'detail_capture_started',
      workerId: options.workerId,
      sourceUrl: listing.href,
      attempt: listing.detail_attempts,
      status: 'processing',
      content: {
        listingId: listing.listing_id,
        href: listing.href,
        cardTitle: listing.card_title || '',
        cardText: listing.card_text || '',
      },
    });

    try {
      const capture = await captureListingRecord(activePage.context(), activePage, listing, options.captureDir);
      activePage = capture.page;
      const content = buildDetailEventContent(listing, capture.detailRecord, options.workerId);
      const contentHash = hashContent(content.detail);
      const previousSuccess = getLatestListingEvent(db, listing.listing_id, {
        eventType: 'detail_capture_succeeded',
      });

      appendListingEvent(db, {
        listingId: listing.listing_id,
        eventType: 'detail_capture_succeeded',
        workerId: options.workerId,
        sourceUrl: listing.href,
        attempt: listing.detail_attempts,
        status: 'done',
        content,
        contentHash,
        screenshotPath: capture.detailRecord.screenshotPath,
        snapshotPath: capture.detailRecord.snapshotPath,
      });

      if (previousSuccess && previousSuccess.content_hash && previousSuccess.content_hash !== contentHash) {
        appendListingEvent(db, {
          listingId: listing.listing_id,
          eventType: 'content_changed',
          workerId: options.workerId,
          sourceUrl: listing.href,
          attempt: listing.detail_attempts,
          status: 'changed',
          content: {
            previousContentHash: previousSuccess.content_hash,
            nextContentHash: contentHash,
            detail: content.detail,
          },
          contentHash,
          screenshotPath: capture.detailRecord.screenshotPath,
          snapshotPath: capture.detailRecord.snapshotPath,
        });
      }

      markHomepageListingProcessed(db, listing.listing_id, capture.detailRecord);
      await appendLog(
        options.logFile,
        `job_done listing_id=${listing.listing_id} title="${capture.detailRecord.title}" screenshot=${capture.detailRecord.screenshotPath}`,
      );
      processedCount += 1;
    } catch (error) {
      const eventType = error?.code === 'LISTING_UNAVAILABLE'
        ? 'listing_unavailable'
        : 'detail_capture_failed';
      appendListingEvent(db, {
        listingId: listing.listing_id,
        eventType,
        workerId: options.workerId,
        sourceUrl: listing.href,
        attempt: listing.detail_attempts,
        status: 'error',
        content: {
          listingId: listing.listing_id,
          href: listing.href,
          cardTitle: listing.card_title || '',
          cardText: listing.card_text || '',
        },
        error: error instanceof Error ? error.message : String(error),
      });
      markHomepageListingFailed(db, listing.listing_id, error instanceof Error ? error.message : error);
      await appendLog(
        options.logFile,
        `job_error listing_id=${listing.listing_id} error="${error instanceof Error ? error.message : String(error)}"`,
      );
    }
  }

  return {
    page: activePage,
    processedCount,
    attemptedCount,
    counts: getHomepageListingCounts(db),
  };
}

async function sleep(ms) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

function computeJitteredPollMs(pollIntervalSeconds, jitterMin, jitterMax) {
  const multiplier = jitterMin + (Math.random() * (jitterMax - jitterMin));
  return {
    waitMs: Math.ceil(pollIntervalSeconds * multiplier * 1000),
    multiplier,
  };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  await ensureDir(options.captureDir);
  await ensureDir(path.dirname(options.logFile));
  await appendLog(
    options.logFile,
    `backlog_start db_path=${options.dbPath} poll_interval_seconds=${options.pollIntervalSeconds} poll_jitter_min=${options.pollJitterMin} poll_jitter_max=${options.pollJitterMax} batch_size=${options.batchSize} limit=${options.limit} worker_id=${options.workerId} headless=${options.headless}`,
  );

  const { db } = openMarketplaceHomepageDatabase(options.dbPath);
  const resolvedUserDataDir = path.isAbsolute(options.userDataDir)
    ? options.userDataDir
    : path.join(process.cwd(), options.userDataDir);

  const context = await chromium.launchPersistentContext(resolvedUserDataDir, {
    headless: options.headless,
    viewport: { width: 1440, height: 1200 },
  });

  try {
    let page = context.pages()[0] || await context.newPage();
    const sessionSummary = await describeFacebookMarketplaceSession(context, page);
    await appendLog(
      options.logFile,
      `worker_session_ready signed_in_user_id=${sessionSummary.signedInUserId || 'n/a'} logged_in=${sessionSummary.loggedIn} current_url=${sessionSummary.currentUrl || 'n/a'}`,
    );
    if (!sessionSummary.loggedIn || !sessionSummary.signedInUserId) {
      throw new Error('Facebook session is not logged in; run with a signed-in persistent profile before processing backlog.');
    }

    let totalProcessed = 0;
    let totalAttempted = 0;
    do {
      const remainingLimit = options.limit > 0 ? Math.max(0, options.limit - totalAttempted) : Infinity;
      if (remainingLimit === 0) {
        await appendLog(options.logFile, `backlog_exit reason=limit_reached attempted=${totalAttempted} processed=${totalProcessed}`);
        break;
      }

      const result = await processBatch(page, db, options, { remainingLimit });
      page = result.page;
      totalProcessed += result.processedCount;
      totalAttempted += result.attemptedCount;
      console.log(JSON.stringify({
        processedCount: result.processedCount,
        attemptedCount: result.attemptedCount,
        totalProcessed,
        totalAttempted,
        counts: result.counts,
      }, null, 2));

      if (options.once) {
        await appendLog(options.logFile, 'backlog_exit mode=once');
        break;
      }

      if (result.processedCount > 0) {
        continue;
      }

      const { waitMs, multiplier } = computeJitteredPollMs(
        options.pollIntervalSeconds,
        options.pollJitterMin,
        options.pollJitterMax,
      );
      await appendLog(
        options.logFile,
        `backlog_sleep seconds=${Math.ceil(waitMs / 1000)} base_poll_interval_seconds=${options.pollIntervalSeconds} jitter_multiplier=${multiplier.toFixed(3)} pending=${result.counts.pending} processing=${result.counts.processing} error=${result.counts.error}`,
      );
      await sleep(waitMs);
    } while (true);
  } finally {
    closeMarketplaceHomepageDatabase(db);
    await context.close();
  }
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`[${new Date().toISOString()}] process_marketplace_homepage_backlog_error ${message}\n`);
  console.error(message);
  process.exit(1);
});
