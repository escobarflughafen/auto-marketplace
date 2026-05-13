const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');
const {
  buildChromiumLaunchOptions,
  createLogger,
  ensureDir,
  safeGoto,
  waitForListingPage,
  expandMarketplaceListingDetails,
  captureListingThumbnails,
  cleanText,
  detectListingUnavailablePage,
  readListingDetailPanelText,
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
  releaseHomepageListingClaim,
  markHomepageListingInactive,
  getHomepageListingCounts,
  hashContent,
  runTransaction,
  appendListingEvent,
  appendWorkflowEvent,
  getLatestListingEvent,
} = require('./marketplace-homepage-db');
const {
  DEFAULT_CREDENTIALS_PATH,
  DEFAULT_CREDENTIALS_PROFILE,
  DEFAULT_LOGIN_TIMEOUT_MS,
  ensureFacebookMarketplaceLogin,
  describeFacebookMarketplaceSession,
  normalizeAuthMode,
} = require('./marketplace-profile-auth');

const log = createLogger('process-marketplace-homepage-backlog');

function readFlagValue(argv, index, flagName) {
  const value = argv[index + 1];
  if (!value || value.startsWith('--')) {
    throw new Error(`Missing value for ${flagName}`);
  }

  return value;
}

function readListingIdFile(filePath) {
  const text = fs.readFileSync(path.resolve(filePath), 'utf8').trim();
  if (!text) {
    return [];
  }

  if (text.startsWith('[') || text.startsWith('{')) {
    const parsed = JSON.parse(text);
    const listingIds = Array.isArray(parsed) ? parsed : parsed.listingIds;
    if (!Array.isArray(listingIds)) {
      throw new Error('Expected listing ID file JSON to be an array or an object with listingIds');
    }
    return listingIds.map((value) => String(value || '').trim()).filter(Boolean);
  }

  return text.split(/\r?\n|,/).map((value) => value.trim()).filter(Boolean);
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
    workerScreenshotDir: path.join(process.cwd(), 'artifacts', 'marketplace-homepage', 'worker-screenshots'),
    workerScreenshotIntervalSeconds: 10,
    workerScreenshotHistoryLimit: 100,
    logFile: path.join(process.cwd(), 'artifacts', 'marketplace-homepage', 'homepage-backlog.log'),
    pollIntervalSeconds: 15,
    pollJitterMin: 1,
    pollJitterMax: 1,
    itemDelaySeconds: 0,
    itemJitterMin: 1,
    itemJitterMax: 1,
    staleAfterSeconds: 30 * 60,
    retryDelaySeconds: 5 * 60,
    maxAttempts: 5,
    batchSize: 3,
    limit: 0,
    statusFilter: 'all',
    sourceFilter: '',
    keywordFilter: '',
    backlogOrder: 'priority',
    seenTimeField: 'last_seen',
    seenAfter: '',
    seenBefore: '',
    listingIds: [],
    listingIdFile: '',
    workerId: `pid-${process.pid}`,
    useCredentials: false,
    authMode: '',
    credentialsPath: DEFAULT_CREDENTIALS_PATH,
    credentialsProfile: DEFAULT_CREDENTIALS_PROFILE,
    loginTimeoutMs: DEFAULT_LOGIN_TIMEOUT_MS,
    once: false,
    drain: false,
    resolveInactive: false,
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
      case '--worker-screenshot-dir':
        options.workerScreenshotDir = readFlagValue(argv, index, arg);
        index += 1;
        break;
      case '--worker-screenshot-interval-seconds':
        options.workerScreenshotIntervalSeconds = parseIntegerFlag(readFlagValue(argv, index, arg), arg, 0);
        index += 1;
        break;
      case '--worker-screenshot-history-limit':
        options.workerScreenshotHistoryLimit = parseIntegerFlag(readFlagValue(argv, index, arg), arg, 0);
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
      case '--item-delay-seconds':
        options.itemDelaySeconds = parseFloatFlag(readFlagValue(argv, index, arg), arg, 0);
        index += 1;
        break;
      case '--item-jitter-min':
        options.itemJitterMin = parseFloatFlag(readFlagValue(argv, index, arg), arg, 0);
        index += 1;
        break;
      case '--item-jitter-max':
        options.itemJitterMax = parseFloatFlag(readFlagValue(argv, index, arg), arg, 0);
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
      case '--status-filter':
        options.statusFilter = readFlagValue(argv, index, arg);
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
      case '--backlog-order':
      case '--order':
        options.backlogOrder = readFlagValue(argv, index, arg);
        index += 1;
        break;
      case '--seen-time-field':
      case '--time-field':
        options.seenTimeField = readFlagValue(argv, index, arg);
        index += 1;
        break;
      case '--seen-after':
      case '--backlog-after':
        options.seenAfter = readFlagValue(argv, index, arg);
        index += 1;
        break;
      case '--seen-before':
      case '--backlog-before':
        options.seenBefore = readFlagValue(argv, index, arg);
        index += 1;
        break;
      case '--listing-id':
        options.listingIds.push(readFlagValue(argv, index, arg));
        index += 1;
        break;
      case '--listing-ids':
        options.listingIds.push(...readFlagValue(argv, index, arg).split(',').map((item) => item.trim()).filter(Boolean));
        index += 1;
        break;
      case '--listing-id-file':
        options.listingIdFile = readFlagValue(argv, index, arg);
        index += 1;
        break;
      case '--worker-id':
        options.workerId = readFlagValue(argv, index, arg);
        index += 1;
        break;
      case '--use-credentials':
        options.useCredentials = true;
        break;
      case '--auth-mode':
        options.authMode = readFlagValue(argv, index, arg);
        index += 1;
        break;
      case '--unauthenticated':
      case '--no-auth':
        options.authMode = 'none';
        break;
      case '--credentials-path':
        options.credentialsPath = readFlagValue(argv, index, arg);
        index += 1;
        break;
      case '--credentials-profile':
        options.credentialsProfile = readFlagValue(argv, index, arg);
        index += 1;
        break;
      case '--login-timeout-seconds':
        options.loginTimeoutMs = parseIntegerFlag(readFlagValue(argv, index, arg), arg, 1) * 1000;
        index += 1;
        break;
      case '--once':
        options.once = true;
        break;
      case '--drain':
      case '--until-empty':
        options.drain = true;
        break;
      case '--resolve-inactive':
        options.resolveInactive = true;
        break;
      case '--skip-inactive':
        options.resolveInactive = false;
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

  if (options.itemJitterMax < options.itemJitterMin) {
    throw new Error('Expected --item-jitter-max to be >= --item-jitter-min');
  }
  options.authMode = normalizeAuthMode(options.authMode, options.useCredentials);

  if (options.once && options.drain) {
    throw new Error('Use either --once or --drain, not both');
  }

  const order = String(options.backlogOrder || '').trim().toLowerCase().replace(/-/g, '_');
  if (!['priority', 'default', 'rank', 'ranked', 'latest', 'newest', 'newest_seen', 'earliest', 'oldest', 'oldest_seen'].includes(order)) {
    throw new Error('Expected --backlog-order to be one of priority, rank, latest, earliest');
  }

  const timeField = String(options.seenTimeField || '').trim().toLowerCase().replace(/-/g, '_');
  if (!['last_seen', 'last_seen_at', 'last', 'first_seen', 'first_seen_at', 'first'].includes(timeField)) {
    throw new Error('Expected --seen-time-field to be one of last_seen, first_seen');
  }

  for (const [flagName, value] of [['--seen-after', options.seenAfter], ['--seen-before', options.seenBefore]]) {
    if (value && Number.isNaN(Date.parse(value))) {
      throw new Error(`Expected ${flagName} to be an ISO-like date/time`);
    }
  }

  if (options.seenAfter && options.seenBefore && Date.parse(options.seenAfter) > Date.parse(options.seenBefore)) {
    throw new Error('Expected --seen-before to be after --seen-after');
  }

  if (options.listingIdFile) {
    options.listingIds.push(...readListingIdFile(options.listingIdFile));
  }
  options.listingIds = [...new Set(options.listingIds.map((id) => String(id || '').trim()).filter(Boolean))];

  return options;
}

async function appendLog(logFile, message) {
  const line = `[${new Date().toISOString()}] ${message}\n`;
  process.stdout.write(line);
  await ensureDir(path.dirname(logFile));
  await fs.promises.appendFile(logFile, line, 'utf8');
}

function safeWorkerPathSegment(workerId) {
  return String(workerId || 'worker')
    .replace(/[^a-z0-9_.-]+/gi, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 160) || 'worker';
}

function workerScreenshotDirectory(options) {
  const rootDir = path.isAbsolute(options.workerScreenshotDir)
    ? options.workerScreenshotDir
    : path.join(process.cwd(), options.workerScreenshotDir);
  return path.join(rootDir, safeWorkerPathSegment(options.workerId));
}

async function pruneWorkerScreenshots(directory, historyLimit) {
  if (historyLimit <= 0) {
    return;
  }

  let entries = [];
  try {
    entries = await fs.promises.readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (error.code === 'ENOENT') return;
    throw error;
  }

  const screenshots = [];
  for (const entry of entries) {
    if (!entry.isFile() || !/\.png$/i.test(entry.name)) {
      continue;
    }
    const filePath = path.join(directory, entry.name);
    const stat = await fs.promises.stat(filePath).catch(() => null);
    if (stat) {
      screenshots.push({ filePath, mtimeMs: stat.mtimeMs });
    }
  }

  screenshots.sort((a, b) => b.mtimeMs - a.mtimeMs);
  await Promise.all(screenshots.slice(historyLimit).map((item) => (
    fs.promises.unlink(item.filePath).catch(() => {})
  )));
}

async function captureWorkerScreenshot(page, options) {
  if (!page || page.isClosed()) {
    return '';
  }

  const directory = workerScreenshotDirectory(options);
  await ensureDir(directory);
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const filePath = path.join(directory, `${timestamp}.png`);
  await page.screenshot({ path: filePath, fullPage: false });
  await pruneWorkerScreenshots(directory, options.workerScreenshotHistoryLimit);
  return filePath;
}

function startWorkerScreenshotMonitor(options, lifecycle) {
  const intervalSeconds = Number(options.workerScreenshotIntervalSeconds || 0);
  if (intervalSeconds <= 0 || options.workerScreenshotHistoryLimit <= 0) {
    return () => {};
  }

  let busy = false;
  let stopped = false;
  const intervalMs = intervalSeconds * 1000;
  const tick = async () => {
    if (stopped || busy || lifecycle.shutdownRequested) {
      return;
    }
    busy = true;
    try {
      await captureWorkerScreenshot(lifecycle.currentPage, options);
    } catch (error) {
      await appendLog(
        options.logFile,
        `worker_screenshot_error error="${error instanceof Error ? error.message : String(error)}"`,
      );
    } finally {
      busy = false;
    }
  };
  const timer = setInterval(tick, intervalMs);
  tick().catch(() => {});
  return () => {
    stopped = true;
    clearInterval(timer);
  };
}

async function captureListingRecord(context, page, listing, captureDir) {
  const activePage = await safeGoto(context, page, listing.href);
  await waitForListingPage(activePage);
  await expandMarketplaceListingDetails(activePage, { logger: log });

  const pageText = cleanText(await activePage.locator('body').innerText().catch(() => ''));
  const unavailable = await detectListingUnavailablePage(activePage, pageText);
  if (unavailable) {
    const error = new Error(`Listing page appears unavailable: ${unavailable.reason}`);
    error.code = 'LISTING_UNAVAILABLE';
    error.reason = unavailable.reason;
    error.unavailable = unavailable;
    throw error;
  }

  const fallbackTitle = listing.card_title || listing.card_text || listing.listing_id;
  let listingContent;
  try {
    const detailPanel = await readListingDetailPanelText(activePage);
    listingContent = extractListingContent(detailPanel.text, detailPanel.title || fallbackTitle);
    listingContent.extractionSource = 'listing_detail_panel';
    listingContent.extractionSelector = detailPanel.selector;
    listingContent.extractionScore = detailPanel.score;
  } catch (error) {
    log(`listing_detail_panel_extract_failed listing_id=${listing.listing_id} fallback=body_text error=${error.message}`);
    listingContent = extractListingContent(pageText, fallbackTitle);
    listingContent.extractionSource = 'body_text_fallback';
  }
  const title = await readListingTitle(activePage, listingContent.rawText || pageText, listingContent.title || fallbackTitle);
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
  const capturedAt = new Date().toISOString();
  const detail = {
    title: detailRecord.title || listingContent.title || '',
    price: listingContent.price || '',
    previousPrice: listingContent.previousPrice || '',
    location: listingContent.location || '',
    condition: listingContent.condition || '',
    listedAgo: listingContent.listedAgo || '',
    sellerName: listingContent.sellerName || '',
    sellerRating: listingContent.sellerRating || '',
    sellerJoined: listingContent.sellerJoined || '',
    availabilityStatus: listingContent.availabilityStatus || '',
    availabilityReason: listingContent.availabilityReason || '',
    description: listingContent.description || '',
    rawText: listingContent.rawText || '',
  };
  const comparableDetail = {
    title: detail.title,
    price: detail.price,
    previousPrice: detail.previousPrice,
    location: detail.location,
    condition: detail.condition,
    sellerName: detail.sellerName,
    sellerRating: detail.sellerRating,
    sellerJoined: detail.sellerJoined,
    availabilityStatus: detail.availabilityStatus,
    availabilityReason: detail.availabilityReason,
    description: detail.description,
  };
  const thumbnailCount = Array.isArray(detailRecord.thumbnails) ? detailRecord.thumbnails.length : 0;
  const extractedFields = {
    title: Boolean(detail.title),
    price: Boolean(detail.price),
    location: Boolean(detail.location),
    condition: Boolean(detail.condition),
    sellerName: Boolean(detail.sellerName),
    description: Boolean(detail.description),
    availability: Boolean(detail.availabilityStatus && detail.availabilityStatus !== 'unknown'),
    screenshot: Boolean(detailRecord.screenshotPath),
    snapshot: Boolean(detailRecord.snapshotPath),
    thumbnails: thumbnailCount > 0,
  };
  const extractedCount = Object.values(extractedFields).filter(Boolean).length;
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
      detailStatusBeforeCapture: listing.detail_status || '',
      attemptsBeforeCapture: listing.detail_attempts ?? null,
    },
    detail,
    comparable: {
      detail: comparableDetail,
    },
    freshness: {
      sourceFirstSeenAt: listing.first_seen_at || '',
      sourceLastSeenAt: listing.last_seen_at || '',
      sourceLastSeenRank: listing.last_seen_rank ?? null,
      listedAgo: detail.listedAgo,
      capturedAt,
      sourceAgeSeconds: listing.last_seen_at
        ? Math.max(0, Math.round((Date.parse(capturedAt) - Date.parse(listing.last_seen_at)) / 1000))
        : null,
    },
    availability: {
      status: detail.availabilityStatus || 'unknown',
      reason: detail.availabilityReason || 'no_signal',
      isInactive: ['sold', 'pending_sale'].includes(detail.availabilityStatus || ''),
      isAvailable: detail.availabilityStatus === 'available',
    },
    extraction: {
      extractedFields,
      extractedCount,
      totalFields: Object.keys(extractedFields).length,
      rawTextLength: detail.rawText.length,
      descriptionLength: detail.description.length,
      thumbnailCount,
    },
    artifacts: {
      screenshotPath: detailRecord.screenshotPath || '',
      snapshotPath: detailRecord.snapshotPath || '',
      thumbnails: detailRecord.thumbnails || [],
    },
    runtime: {
      workerId,
      attempt: listing.detail_attempts,
      capturedAt,
      contentHashStrategy: 'comparable.detail.v1',
    },
  };
}

function buildJobCardEventContent(listing, workerId, extra = {}) {
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
      detailStatusBeforeCapture: listing.detail_status || '',
      attemptsBeforeCapture: listing.detail_attempts ?? null,
    },
    runtime: {
      workerId,
      attempt: listing.detail_attempts,
      capturedAt: new Date().toISOString(),
    },
    ...extra,
  };
}

function contentHashForDetailEvent(content) {
  return hashContent(content.comparable?.detail || content.detail || {});
}

function buildClaimOptions(options) {
  return {
    workerId: options.workerId,
    staleAfterSeconds: options.staleAfterSeconds,
    retryDelaySeconds: options.retryDelaySeconds,
    maxAttempts: options.maxAttempts,
    statusFilter: options.statusFilter,
    sourceFilter: options.sourceFilter,
    keywordFilter: options.keywordFilter,
    backlogOrder: options.backlogOrder,
    seenTimeField: options.seenTimeField,
    seenAfter: options.seenAfter,
    seenBefore: options.seenBefore,
    listingIds: options.listingIds,
    listingIdTable: options.listingIdTable,
    startEventBuilder: (listing) => ({
      workflowRunId: options.workerId,
      listingId: listing.listing_id,
      eventType: 'detail_capture_started',
      workerId: options.workerId,
      sourceUrl: listing.href,
      attempt: listing.detail_attempts,
      status: 'processing',
      content: buildJobCardEventContent(listing, options.workerId),
    }),
  };
}

async function processBatch(page, db, options, state = {}) {
  let activePage = page;
  let processedCount = 0;
  let attemptedCount = 0;
  const lifecycle = state.lifecycle || {};
  lifecycle.currentPage = activePage;
  const remainingLimit = Number.isFinite(state.remainingLimit) ? state.remainingLimit : Infinity;
  const batchLimit = Math.min(options.batchSize, remainingLimit);

  for (let index = 0; index < batchLimit; index += 1) {
    if (lifecycle.shutdownRequested) {
      break;
    }

    const listing = claimNextPendingHomepageListing(db, buildClaimOptions(options));

    if (!listing) {
      break;
    }
    lifecycle.activeListing = listing;

    await appendLog(
      options.logFile,
      `job_start listing_id=${listing.listing_id} href=${listing.href} attempt=${listing.detail_attempts}`,
    );
    attemptedCount += 1;

    try {
      const capture = await captureListingRecord(activePage.context(), activePage, listing, options.captureDir);
      activePage = capture.page;
      lifecycle.currentPage = activePage;
      const content = buildDetailEventContent(listing, capture.detailRecord, options.workerId);
      const contentHash = contentHashForDetailEvent(content);
      const previousSuccess = getLatestListingEvent(db, listing.listing_id, {
        eventType: 'detail_capture_succeeded',
      });
      const availabilityStatus = capture.detailRecord.listingContent?.availabilityStatus || 'unknown';
      const inactiveStatus = ['sold', 'pending_sale'].includes(availabilityStatus)
        ? availabilityStatus
        : '';

      if (inactiveStatus && !options.resolveInactive) {
        runTransaction(db, () => {
          appendListingEvent(db, {
            workflowRunId: options.workerId,
            listingId: listing.listing_id,
            eventType: 'detail_capture_bypassed',
            workerId: options.workerId,
            sourceUrl: listing.href,
            attempt: listing.detail_attempts,
            status: inactiveStatus,
            content,
            contentHash,
            screenshotPath: capture.detailRecord.screenshotPath,
            snapshotPath: capture.detailRecord.snapshotPath,
            error: capture.detailRecord.listingContent?.availabilityReason || inactiveStatus,
          });
          markHomepageListingInactive(
            db,
            listing.listing_id,
            inactiveStatus,
            capture.detailRecord,
            capture.detailRecord.listingContent?.availabilityReason || inactiveStatus,
          );
        });
        await appendLog(
          options.logFile,
          `job_bypassed listing_id=${listing.listing_id} availability=${inactiveStatus} reason=${capture.detailRecord.listingContent?.availabilityReason || inactiveStatus} screenshot=${capture.detailRecord.screenshotPath}`,
        );
        lifecycle.activeListing = null;
        continue;
      }

      runTransaction(db, () => {
        appendListingEvent(db, {
          workflowRunId: options.workerId,
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
            workflowRunId: options.workerId,
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
              comparable: content.comparable,
              freshness: content.freshness,
              availability: content.availability,
              extraction: content.extraction,
            },
            contentHash,
            screenshotPath: capture.detailRecord.screenshotPath,
            snapshotPath: capture.detailRecord.snapshotPath,
          });
        }

        markHomepageListingProcessed(db, listing.listing_id, capture.detailRecord);
      });
      await appendLog(
        options.logFile,
        `job_done listing_id=${listing.listing_id} title="${capture.detailRecord.title}" screenshot=${capture.detailRecord.screenshotPath}`,
      );
      lifecycle.activeListing = null;
      processedCount += 1;
    } catch (error) {
      if (isFatalBrowserContextError(error) || lifecycle.shutdownRequested) {
        const reason = lifecycle.shutdownRequested
          ? `worker_shutdown:${lifecycle.signal || 'requested'}`
          : 'fatal_browser_context_error';
        runTransaction(db, () => {
          appendListingEvent(db, {
            workflowRunId: options.workerId,
            listingId: listing.listing_id,
            eventType: 'detail_capture_interrupted',
            workerId: options.workerId,
            sourceUrl: listing.href,
            attempt: listing.detail_attempts,
            status: 'interrupted',
            content: buildJobCardEventContent(listing, options.workerId, {
              interruption: {
                reason,
                retryable: true,
              },
              error: {
                type: error?.code || 'INTERRUPTED',
                message: error instanceof Error ? error.message : String(error),
              },
            }),
            error: error instanceof Error ? error.message : String(error),
          });
          releaseHomepageListingClaim(db, listing.listing_id, {
            workerId: options.workerId,
            nextStatus: 'pending',
            reason,
            decrementAttempts: true,
          });
        });
        lifecycle.activeListing = null;
        await appendLog(
          options.logFile,
          `job_interrupted listing_id=${listing.listing_id} reason=${reason} error="${error instanceof Error ? error.message : String(error)}"`,
        );
        appendWorkflowLifecycleEvent(db, options, lifecycle.shutdownRequested ? 'active_claim_interrupted' : 'browser_context_failed', {
          status: lifecycle.shutdownRequested ? 'interrupted' : 'error',
          error,
          content: {
            listingId: listing.listing_id,
            reason,
          },
        });
        await appendLog(
          options.logFile,
          `backlog_exit reason=${reason} listing_id=${listing.listing_id} error="${error instanceof Error ? error.message : String(error)}"`,
        );
        if (lifecycle.shutdownRequested) {
          break;
        }
        throw error;
      }

      const eventType = error?.code === 'LISTING_UNAVAILABLE'
        ? 'listing_unavailable'
        : 'detail_capture_failed';
      runTransaction(db, () => {
        appendListingEvent(db, {
          workflowRunId: options.workerId,
          listingId: listing.listing_id,
          eventType,
          workerId: options.workerId,
          sourceUrl: listing.href,
          attempt: listing.detail_attempts,
          status: 'error',
          content: buildJobCardEventContent(listing, options.workerId, {
            unavailable: error?.unavailable || null,
            error: {
              type: error?.code || 'ERROR',
              message: error instanceof Error ? error.message : String(error),
            },
          }),
          error: error instanceof Error ? error.message : String(error),
        });
        markHomepageListingFailed(db, listing.listing_id, error instanceof Error ? error.message : error);
      });
      await appendLog(
        options.logFile,
        `job_error listing_id=${listing.listing_id} error="${error instanceof Error ? error.message : String(error)}"`,
      );
      lifecycle.activeListing = null;
    }
  }

  return {
    page: activePage,
    processedCount,
    attemptedCount,
    counts: getHomepageListingCounts(db),
  };
}

async function sleep(ms, lifecycle = null) {
  await new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    if (lifecycle) {
      lifecycle.wakeShutdown = () => {
        clearTimeout(timer);
        resolve();
      };
      if (lifecycle.shutdownRequested) {
        lifecycle.wakeShutdown();
      }
    }
  });
  if (lifecycle) {
    lifecycle.wakeShutdown = null;
  }
}

function installListingIdTempTable(db, listingIds) {
  if (!listingIds.length) {
    return '';
  }

  db.exec(`
    CREATE TEMP TABLE IF NOT EXISTS selected_resolve_listing_ids (
      listing_id TEXT PRIMARY KEY
    );
    DELETE FROM selected_resolve_listing_ids;
  `);
  const insert = db.prepare('INSERT OR IGNORE INTO selected_resolve_listing_ids (listing_id) VALUES (?)');
  db.exec('BEGIN');
  try {
    for (const listingId of listingIds) {
      insert.run(listingId);
    }
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
  return 'selected_resolve_listing_ids';
}

function computeJitteredPollMs(pollIntervalSeconds, jitterMin, jitterMax) {
  const multiplier = jitterMin + (Math.random() * (jitterMax - jitterMin));
  return {
    waitMs: Math.ceil(pollIntervalSeconds * multiplier * 1000),
    multiplier,
  };
}

function shouldDelayBetweenItems(options, result, remainingLimit) {
  if (!result.attemptedCount || options.itemDelaySeconds <= 0) {
    return false;
  }

  if (options.once) {
    return false;
  }

  if (options.limit > 0 && remainingLimit <= 0) {
    return false;
  }

  return true;
}

function isFatalBrowserContextError(error) {
  const message = error instanceof Error ? error.message : String(error || '');
  return /(?:Target page, context or browser has been closed|Browser has been closed|browser has disconnected)/iu.test(message);
}

function appendWorkflowLifecycleEvent(db, options, eventType, event = {}) {
  try {
    return appendWorkflowEvent(db, {
      workflowRunId: options.workerId,
      eventType,
      status: event.status || '',
      content: event.content || {},
      error: event.error instanceof Error ? event.error.message : String(event.error || ''),
    });
  } catch (error) {
    log(`workflow_event_append_failed type=${eventType} error=${error.message}`);
    return null;
  }
}

function installShutdownHandlers(db, options, lifecycle) {
  const handleSignal = (signal) => {
    if (lifecycle.shutdownRequested) {
      return;
    }
    lifecycle.shutdownRequested = true;
    lifecycle.signal = signal;
    appendWorkflowLifecycleEvent(db, options, 'shutdown_requested', {
      status: 'stopping',
      content: {
        signal,
        activeListingId: lifecycle.activeListing?.listing_id || '',
      },
    });
    if (typeof lifecycle.wakeShutdown === 'function') {
      lifecycle.wakeShutdown();
    }
    if (lifecycle.context) {
      lifecycle.context.close().catch(() => {});
    }
  };

  process.once('SIGINT', handleSignal);
  process.once('SIGTERM', handleSignal);
  return () => {
    process.off('SIGINT', handleSignal);
    process.off('SIGTERM', handleSignal);
  };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  await ensureDir(options.captureDir);
  await ensureDir(options.workerScreenshotDir);
  await ensureDir(path.dirname(options.logFile));
  await appendLog(
    options.logFile,
    `backlog_start db_path=${options.dbPath} mode=${options.drain ? 'drain' : options.once ? 'once' : 'continuous'} poll_interval_seconds=${options.pollIntervalSeconds} poll_jitter_min=${options.pollJitterMin} poll_jitter_max=${options.pollJitterMax} item_delay_seconds=${options.itemDelaySeconds} item_jitter_min=${options.itemJitterMin} item_jitter_max=${options.itemJitterMax} batch_size=${options.batchSize} limit=${options.limit} status_filter=${options.statusFilter || 'all'} source_filter=${options.sourceFilter || 'n/a'} keyword_filter=${options.keywordFilter || 'n/a'} backlog_order=${options.backlogOrder} seen_time_field=${options.seenTimeField} seen_after=${options.seenAfter || 'n/a'} seen_before=${options.seenBefore || 'n/a'} listing_ids=${options.listingIds.length} resolve_inactive=${options.resolveInactive} worker_id=${options.workerId} headless=${options.headless} auth_mode=${options.authMode} use_credentials=${options.useCredentials} worker_screenshot_interval_seconds=${options.workerScreenshotIntervalSeconds} worker_screenshot_history_limit=${options.workerScreenshotHistoryLimit}`,
  );

  const { db } = openMarketplaceHomepageDatabase(options.dbPath);
  const lifecycle = {
    shutdownRequested: false,
    signal: '',
    activeListing: null,
    context: null,
    currentPage: null,
    wakeShutdown: null,
  };
  const uninstallShutdownHandlers = installShutdownHandlers(db, options, lifecycle);
  let context = null;
  let stopScreenshotMonitor = () => {};
  try {
    if (options.listingIds.length > 0) {
      options.listingIdTable = installListingIdTempTable(db, options.listingIds);
      options.listingIds = [];
    }
    const resolvedUserDataDir = path.isAbsolute(options.userDataDir)
      ? options.userDataDir
      : path.join(process.cwd(), options.userDataDir);

    appendWorkflowLifecycleEvent(db, options, 'worker_started', {
      status: 'running',
      content: {
        mode: options.drain ? 'drain' : options.once ? 'once' : 'continuous',
        batchSize: options.batchSize,
        limit: options.limit,
      },
    });
    appendWorkflowLifecycleEvent(db, options, 'browser_context_launch_started', {
      status: 'starting',
      content: {
        userDataDir: resolvedUserDataDir,
        headless: options.headless,
      },
    });
    context = await chromium.launchPersistentContext(resolvedUserDataDir, buildChromiumLaunchOptions({
      headless: options.headless,
      viewport: { width: 1440, height: 1200 },
    }));
    lifecycle.context = context;
    appendWorkflowLifecycleEvent(db, options, 'browser_context_ready', {
      status: 'running',
      content: {
        userDataDir: resolvedUserDataDir,
        headless: options.headless,
      },
    });

    let page = await ensureFacebookMarketplaceLogin(context, {
      useCredentials: options.useCredentials,
      authMode: options.authMode,
      credentialsPath: options.credentialsPath,
      credentialsProfile: options.credentialsProfile,
      loginTimeoutMs: options.loginTimeoutMs,
      failOnAdditionalVerification: options.headless,
      logger: (message) => appendLog(options.logFile, message),
    });
    lifecycle.currentPage = page;
    stopScreenshotMonitor = startWorkerScreenshotMonitor(options, lifecycle);
    const sessionSummary = await describeFacebookMarketplaceSession(context, page, {
      credentialsPath: options.credentialsPath,
      credentialsProfile: options.credentialsProfile,
    });
    await appendLog(
      options.logFile,
      `worker_session_ready signed_in_user_id=${sessionSummary.signedInUserId || 'n/a'} logged_in=${sessionSummary.loggedIn} current_url=${sessionSummary.currentUrl || 'n/a'}`,
    );
    appendWorkflowLifecycleEvent(db, options, 'session_ready', {
      status: sessionSummary.loggedIn && sessionSummary.signedInUserId ? 'authenticated' : 'unauthenticated',
      content: {
        loggedIn: sessionSummary.loggedIn,
        signedInUserId: sessionSummary.signedInUserId || '',
        currentUrl: sessionSummary.currentUrl || '',
      },
    });
    if (!['none', 'optional'].includes(options.authMode) && (!sessionSummary.loggedIn || !sessionSummary.signedInUserId)) {
      throw new Error('Facebook session is not fully authenticated; refresh the signed-in persistent profile or run a headed worker and complete Facebook verification before processing backlog.');
    }

    let totalProcessed = 0;
    let totalAttempted = 0;
    do {
      const remainingLimit = options.limit > 0 ? Math.max(0, options.limit - totalAttempted) : Infinity;
      if (remainingLimit === 0) {
        await appendLog(options.logFile, `backlog_exit reason=limit_reached attempted=${totalAttempted} processed=${totalProcessed}`);
        break;
      }

      const result = await processBatch(page, db, options, { remainingLimit, lifecycle });
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

      if (lifecycle.shutdownRequested) {
        await appendLog(options.logFile, `backlog_exit reason=shutdown_requested signal=${lifecycle.signal || 'n/a'} attempted=${totalAttempted} processed=${totalProcessed}`);
        break;
      }

      if (options.drain && result.attemptedCount === 0) {
        await appendLog(
          options.logFile,
          `backlog_exit mode=drain reason=no_eligible_jobs attempted=${totalAttempted} processed=${totalProcessed} pending=${result.counts.pending} processing=${result.counts.processing} error=${result.counts.error}`,
        );
        break;
      }

      if (result.attemptedCount > 0) {
        const nextRemainingLimit = options.limit > 0
          ? Math.max(0, options.limit - totalAttempted)
          : Infinity;
        if (shouldDelayBetweenItems(options, result, nextRemainingLimit)) {
          const { waitMs, multiplier } = computeJitteredPollMs(
            options.itemDelaySeconds,
            options.itemJitterMin,
            options.itemJitterMax,
          );
          await appendLog(
            options.logFile,
            `backlog_item_sleep seconds=${Math.ceil(waitMs / 1000)} base_item_delay_seconds=${options.itemDelaySeconds} jitter_multiplier=${multiplier.toFixed(3)} attempted=${totalAttempted} processed=${totalProcessed}`,
          );
          await sleep(waitMs, lifecycle);
        }
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
      await sleep(waitMs, lifecycle);
    } while (true);
    appendWorkflowLifecycleEvent(db, options, 'worker_completed', {
      status: lifecycle.shutdownRequested ? 'stopped' : 'completed',
      content: {
        signal: lifecycle.signal || '',
      },
    });
  } catch (error) {
    if (lifecycle.shutdownRequested) {
      appendWorkflowLifecycleEvent(db, options, 'worker_completed', {
        status: 'stopped',
        content: {
          signal: lifecycle.signal || '',
          activeListingId: lifecycle.activeListing?.listing_id || '',
          stopError: error instanceof Error ? error.message : String(error),
        },
      });
      return;
    }
    appendWorkflowLifecycleEvent(db, options, 'worker_failed', {
      status: 'error',
      error,
      content: {
        shutdownRequested: lifecycle.shutdownRequested,
        signal: lifecycle.signal || '',
        activeListingId: lifecycle.activeListing?.listing_id || '',
      },
    });
    throw error;
  } finally {
    uninstallShutdownHandlers();
    stopScreenshotMonitor();
    if (context) {
      appendWorkflowLifecycleEvent(db, options, 'browser_context_closing', {
        status: 'stopping',
      });
      await context.close().catch(() => {});
      appendWorkflowLifecycleEvent(db, options, 'browser_context_closed', {
        status: 'stopped',
      });
    }
    closeMarketplaceHomepageDatabase(db);
  }
}

if (require.main === module) {
  main().catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`[${new Date().toISOString()}] process_marketplace_homepage_backlog_error ${message}\n`);
    console.error(message);
    process.exit(1);
  });
}

module.exports = {
  parseArgs,
  buildDetailEventContent,
  buildJobCardEventContent,
  contentHashForDetailEvent,
  buildClaimOptions,
  computeJitteredPollMs,
  shouldDelayBetweenItems,
  isFatalBrowserContextError,
  appendWorkflowLifecycleEvent,
  safeWorkerPathSegment,
  workerScreenshotDirectory,
  pruneWorkerScreenshots,
};
