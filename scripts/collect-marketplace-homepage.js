const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');
const {
  buildChromiumLaunchOptions,
  createLogger,
  ensureDir,
  getKnownMarketplaceAreaFromLocation,
  safeGoto,
  setMarketplaceLocation,
  setMarketplaceRadius,
  waitForMarketplaceResults,
  scrollMarketplaceResults,
  cleanText,
} = require('./marketplace-utils');
const {
  DEFAULT_DB_PATH,
  canonicalizeListingUrl,
  extractListingId,
  openMarketplaceHomepageDatabase,
  closeMarketplaceHomepageDatabase,
  upsertHomepageListingWithStatus,
  scanPurchaseHistoryMatchesForListings,
  getHomepageListingCounts,
} = require('./marketplace-homepage-db');
const {
  appendRegulatedListingEvent,
  appendRegulatedWorkflowEvent,
} = require('./marketplace-worker-event-writer');
const {
  DEFAULT_CREDENTIALS_PATH,
  DEFAULT_CREDENTIALS_PROFILE,
  DEFAULT_LOGIN_TIMEOUT_MS,
  ensureFacebookMarketplaceLogin,
  describeFacebookMarketplaceSession,
  normalizeAuthMode,
} = require('./marketplace-profile-auth');
const {
  applyWorkerScreenshotDefaults,
  normalizeWorkerScreenshotOptions,
  startWorkerScreenshotMonitor,
} = require('./marketplace-worker-screenshots');

const DEFAULT_HOME_URL = 'https://www.facebook.com/marketplace/';
const log = createLogger('collect-marketplace-homepage');

function normalizeOptionalText(value) {
  return String(value ?? '').trim();
}

function parseOptionalPositiveInteger(value, fieldName) {
  const text = normalizeOptionalText(value);
  if (!text) {
    return null;
  }
  const parsed = Number.parseInt(text, 10);
  if (!Number.isFinite(parsed) || parsed < 1) {
    throw new Error(`Expected ${fieldName} to be an integer >= 1`);
  }
  return parsed;
}

function parseKeywordTargets(rawValue) {
  const text = normalizeOptionalText(rawValue);
  if (!text) {
    return [];
  }

  let rows;
  try {
    rows = JSON.parse(text);
  } catch (error) {
    throw new Error(`Expected --keyword-targets to be JSON: ${error.message}`);
  }

  if (!Array.isArray(rows)) {
    throw new Error('Expected --keyword-targets to be a JSON array');
  }

  return rows.map((row, index) => {
    if (!row || typeof row !== 'object' || Array.isArray(row)) {
      throw new Error(`Expected --keyword-targets row ${index + 1} to be an object`);
    }
    const keyword = normalizeOptionalText(row.keyword || row.query);
    if (!keyword) {
      throw new Error(`Expected --keyword-targets row ${index + 1} to include keyword`);
    }
    const target = {
      keyword,
      location: normalizeOptionalText(row.location),
      minPrice: parseOptionalPositiveInteger(row.minPrice ?? row.min_price, `keyword target ${index + 1} minPrice`),
      maxPrice: parseOptionalPositiveInteger(row.maxPrice ?? row.max_price, `keyword target ${index + 1} maxPrice`),
      daysSinceListed: parseOptionalPositiveInteger(row.daysSinceListed ?? row.days_since_listed, `keyword target ${index + 1} daysSinceListed`),
      itemCondition: normalizeOptionalText(row.itemCondition ?? row.item_condition),
      maxItems: parseOptionalPositiveInteger(row.maxItems ?? row.max_items, `keyword target ${index + 1} maxItems`),
    };
    if (target.minPrice !== null && target.maxPrice !== null && target.maxPrice < target.minPrice) {
      throw new Error(`Expected keyword target ${index + 1} maxPrice to be >= minPrice`);
    }
    return target;
  });
}

function marketplaceAreaForKeywordTarget(target, fallbackLocation = '') {
  return getKnownMarketplaceAreaFromLocation(target.location)
    || getKnownMarketplaceAreaFromLocation(fallbackLocation)
    || '';
}

function buildMarketplaceKeywordSearchUrl(target, options = {}) {
  const area = marketplaceAreaForKeywordTarget(target, options.location);
  const basePath = area
    ? `https://www.facebook.com/marketplace/${encodeURIComponent(area)}/search`
    : 'https://www.facebook.com/marketplace/search';
  const url = new URL(basePath);
  url.searchParams.set('query', target.keyword);
  url.searchParams.set('exact', 'false');
  if (target.minPrice !== null && target.minPrice !== undefined) {
    url.searchParams.set('minPrice', String(target.minPrice));
  }
  if (target.maxPrice !== null && target.maxPrice !== undefined) {
    url.searchParams.set('maxPrice', String(target.maxPrice));
  }
  if (target.daysSinceListed !== null && target.daysSinceListed !== undefined) {
    url.searchParams.set('daysSinceListed', String(target.daysSinceListed));
  }
  if (target.itemCondition) {
    url.searchParams.set('itemCondition', target.itemCondition);
  }
  return url.toString();
}

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

function parseArgs(argv) {
  const options = applyWorkerScreenshotDefaults({
    startUrl: DEFAULT_HOME_URL,
    startUrlExplicit: false,
    userDataDir: path.join(process.cwd(), 'profiles', 'facebook-marketplace'),
    dbPath: DEFAULT_DB_PATH,
    logFile: path.join(process.cwd(), 'artifacts', 'marketplace-homepage', 'homepage-collector.log'),
    snapshotFile: path.join(process.cwd(), 'artifacts', 'marketplace-homepage', 'latest-cycle.json'),
    maxItems: 10,
    collectAll: false,
    firstLoadOnly: false,
    initialLoadWaitMs: 5000,
    maxRuntimeSeconds: 120,
    stablePasses: 3,
    refreshSeconds: 5 * 60,
    refreshJitterMin: 0.25,
    refreshJitterMax: 1.5,
    once: false,
    headless: true,
    location: '',
    radiusMiles: 0,
    keywordTargets: [],
    keywordTargetsRaw: '',
    useCredentials: false,
    authMode: '',
    credentialsPath: DEFAULT_CREDENTIALS_PATH,
    credentialsProfile: DEFAULT_CREDENTIALS_PROFILE,
    loginTimeoutMs: DEFAULT_LOGIN_TIMEOUT_MS,
    workerId: `pid-${process.pid}`,
  });

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    switch (arg) {
      case '--start-url':
        options.startUrl = readFlagValue(argv, index, arg);
        options.startUrlExplicit = true;
        index += 1;
        break;
      case '--user-data-dir':
        options.userDataDir = readFlagValue(argv, index, arg);
        index += 1;
        break;
      case '--db-path':
        options.dbPath = readFlagValue(argv, index, arg);
        index += 1;
        break;
      case '--log-file':
        options.logFile = readFlagValue(argv, index, arg);
        index += 1;
        break;
      case '--snapshot-file':
        options.snapshotFile = readFlagValue(argv, index, arg);
        index += 1;
        break;
      case '--max-items':
        options.maxItems = parseIntegerFlag(readFlagValue(argv, index, arg), arg, 1);
        index += 1;
        break;
      case '--collect-all':
        options.collectAll = true;
        break;
      case '--first-load-only':
      case '--no-scroll':
        options.firstLoadOnly = true;
        break;
      case '--initial-load-wait-ms':
        options.initialLoadWaitMs = parseIntegerFlag(readFlagValue(argv, index, arg), arg, 0);
        index += 1;
        break;
      case '--max-runtime-seconds':
        options.maxRuntimeSeconds = parseIntegerFlag(readFlagValue(argv, index, arg), arg, 1);
        index += 1;
        break;
      case '--stable-passes':
        options.stablePasses = parseIntegerFlag(readFlagValue(argv, index, arg), arg, 1);
        index += 1;
        break;
      case '--refresh-seconds':
        options.refreshSeconds = parseIntegerFlag(readFlagValue(argv, index, arg), arg, 1);
        index += 1;
        break;
      case '--refresh-jitter-min':
        options.refreshJitterMin = Number.parseFloat(readFlagValue(argv, index, arg));
        if (!Number.isFinite(options.refreshJitterMin) || options.refreshJitterMin < 0) {
          throw new Error(`Expected ${arg} to be a number >= 0`);
        }
        index += 1;
        break;
      case '--refresh-jitter-max':
        options.refreshJitterMax = Number.parseFloat(readFlagValue(argv, index, arg));
        if (!Number.isFinite(options.refreshJitterMax) || options.refreshJitterMax < 0) {
          throw new Error(`Expected ${arg} to be a number >= 0`);
        }
        index += 1;
        break;
      case '--once':
        options.once = true;
        break;
      case '--location':
        options.location = readFlagValue(argv, index, arg);
        index += 1;
        break;
      case '--radius-miles':
        options.radiusMiles = parseIntegerFlag(readFlagValue(argv, index, arg), arg, 1);
        index += 1;
        break;
      case '--keyword-targets':
      case '--search-keyword-targets':
        options.keywordTargetsRaw = readFlagValue(argv, index, arg);
        options.keywordTargets = parseKeywordTargets(options.keywordTargetsRaw);
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
      case '--worker-id':
        options.workerId = readFlagValue(argv, index, arg);
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
      case '--worker-screenshot-format':
        options.workerScreenshotFormat = readFlagValue(argv, index, arg);
        index += 1;
        break;
      case '--worker-screenshot-quality':
        options.workerScreenshotQuality = parseIntegerFlag(readFlagValue(argv, index, arg), arg, 1);
        index += 1;
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

  if (options.refreshJitterMax < options.refreshJitterMin) {
    throw new Error('Expected --refresh-jitter-max to be >= --refresh-jitter-min');
  }
  options.authMode = normalizeAuthMode(options.authMode, options.useCredentials);
  normalizeWorkerScreenshotOptions(options);

  if (options.location && !options.startUrlExplicit) {
    const knownArea = getKnownMarketplaceAreaFromLocation(options.location);
    if (knownArea) {
      options.startUrl = `https://www.facebook.com/marketplace/${encodeURIComponent(knownArea)}/`;
    }
  }

  return options;
}

async function appendLog(logFile, message) {
  const line = `[${new Date().toISOString()}] ${message}\n`;
  process.stdout.write(line);
  await ensureDir(path.dirname(logFile));
  await fs.promises.appendFile(logFile, line, 'utf8');
}

function collectorEventBase(options) {
  return {
    workflowRunId: options.workerId,
    workerId: options.workerId,
    workerType: 'collector',
    strategy: 'feed',
  };
}

function appendCollectorWorkflowEvent(db, options, eventType, event = {}) {
  try {
    return appendRegulatedWorkflowEvent(db, {
      ...collectorEventBase(options),
      eventType,
      status: event.status || '',
      payload: event.payload || {},
      error: event.error instanceof Error ? event.error.message : String(event.error || ''),
    });
  } catch (error) {
    log(`collector_workflow_event_append_failed type=${eventType} error=${error.message}`);
    return null;
  }
}

function appendCollectorListingEvent(db, options, listing, event = {}) {
  try {
    return appendRegulatedListingEvent(db, {
      ...collectorEventBase(options),
      eventType: 'listing_observed',
      listingId: listing.listing_id,
      sourceUrl: listing.href,
      status: event.status || '',
      payload: {
        listingId: listing.listing_id,
        href: listing.href,
        source: listing.source || 'homepage',
        sourceKeyword: listing.source_keyword || '',
        outcome: event.outcome || event.status || '',
        rank: listing.last_seen_rank,
        cardTitle: listing.card_title || '',
        cardText: listing.card_text || '',
      },
    });
  } catch (error) {
    log(`collector_listing_event_append_failed listing_id=${listing.listing_id || ''} error=${error.message}`);
    return null;
  }
}

async function readHomepageItems(page) {
  return page.evaluate(() => {
    const seenListingIds = new Set();
    return Array.from(document.querySelectorAll('a[href*="/marketplace/item/"]'))
      .map((anchor) => {
        const href = anchor.href || '';
        const idMatch = href.match(/\/marketplace\/item\/(\d+)/);
        const listingId = idMatch ? idMatch[1] : href;
        if (!listingId || seenListingIds.has(listingId)) {
          return null;
        }

        const rawText = anchor.innerText || anchor.parentElement?.innerText || '';
        const lines = rawText
          .split('\n')
          .map((line) => line.replace(/\s+/g, ' ').trim())
          .filter(Boolean);

        seenListingIds.add(listingId);
        return {
          listingId,
          href,
          title: lines[0] || '',
          text: lines.join(' | '),
        };
      })
      .filter(Boolean);
  });
}

async function collectHomepageItems(page, options) {
  const startedAt = Date.now();
  const itemsByListingId = new Map();
  let stableCount = 0;
  const targetLabel = options.collectAll ? 'all' : String(options.maxItems);
  let firstPass = true;
  let scrollPasses = 0;
  let readPasses = 0;
  let stopReason = 'unknown';

  while (
    (options.collectAll || itemsByListingId.size < options.maxItems)
    && (Date.now() - startedAt) < (options.maxRuntimeSeconds * 1000)
  ) {
    readPasses += 1;
    const visibleItems = await readHomepageItems(page);
    for (const item of visibleItems) {
      const href = canonicalizeListingUrl(item.href);
      const listingId = item.listingId || extractListingId(href) || href;
      if (!itemsByListingId.has(listingId)) {
        itemsByListingId.set(listingId, {
          listingId,
          href,
          title: cleanText(item.title),
          text: cleanText(item.text),
        });
      }
    }

    log(`collect_progress items=${itemsByListingId.size}/${targetLabel} stable_passes=${stableCount}/${options.stablePasses} collect_all=${options.collectAll} first_load_only=${options.firstLoadOnly}`);
    if (!options.collectAll && itemsByListingId.size >= options.maxItems) {
      stopReason = 'max_items';
      break;
    }

    if (options.firstLoadOnly) {
      if (firstPass && options.initialLoadWaitMs > 0) {
        log(`collect_wait_initial_load ms=${options.initialLoadWaitMs}`);
        await page.waitForTimeout(options.initialLoadWaitMs);
        firstPass = false;
        continue;
      }

      log('collect_stop reason=first_load_only');
      stopReason = 'first_load_only';
      break;
    }

    const beforeCount = itemsByListingId.size;
    scrollPasses += 1;
    await scrollMarketplaceResults(page, {
      scrolls: 1,
      wheelDelta: 1600,
      timeoutMs: 5000,
      settleTimeMs: 900,
      maxStableIterations: 1,
      logger: log,
    });

    const afterScrollItems = await readHomepageItems(page);
    for (const item of afterScrollItems) {
      const href = canonicalizeListingUrl(item.href);
      const listingId = item.listingId || extractListingId(href) || href;
      if (!itemsByListingId.has(listingId)) {
        itemsByListingId.set(listingId, {
          listingId,
          href,
          title: cleanText(item.title),
          text: cleanText(item.text),
        });
      }
    }

    stableCount = itemsByListingId.size > beforeCount ? 0 : stableCount + 1;
    if (stableCount >= options.stablePasses) {
      log(`collect_stop reason=stable_results stable_passes=${stableCount}`);
      stopReason = 'stable_results';
      break;
    }
  }

  const elapsedMs = Date.now() - startedAt;
  if (stopReason === 'unknown') {
    stopReason = elapsedMs >= (options.maxRuntimeSeconds * 1000)
      ? 'max_runtime'
      : 'loop_complete';
  }

  const collectedItems = Array.from(itemsByListingId.values());
  const limitedItems = options.collectAll
    ? collectedItems
    : collectedItems.slice(0, options.maxItems);

  return {
    items: limitedItems.map((item, index) => ({
      ...item,
      rank: index + 1,
    })),
    stats: {
      stopReason,
      elapsedMs,
      elapsedSeconds: Number((elapsedMs / 1000).toFixed(3)),
      readPasses,
      scrollPasses,
      stablePassesReached: stableCount,
      stablePassesTarget: options.stablePasses,
      runtimeLimitSeconds: options.maxRuntimeSeconds,
      runtimeLimitReached: stopReason === 'max_runtime',
      itemLimitReached: stopReason === 'max_items',
      firstLoadOnly: options.firstLoadOnly,
      collectAll: options.collectAll,
      maxItemsTarget: options.collectAll ? null : options.maxItems,
      totalUniqueItems: limitedItems.length,
    },
  };
}

function summarizeUpsertOutcomes(results) {
  return results.reduce((summary, result) => {
    summary[result.outcome] += 1;
    return summary;
  }, {
    new: 0,
    existing_same: 0,
    existing_updated: 0,
  });
}

async function writeCycleSnapshot(snapshotFile, cycleSummary) {
  const resolvedPath = path.isAbsolute(snapshotFile)
    ? snapshotFile
    : path.join(process.cwd(), snapshotFile);
  await ensureDir(path.dirname(resolvedPath));
  await fs.promises.writeFile(resolvedPath, JSON.stringify(cycleSummary, null, 2), 'utf8');
  return resolvedPath;
}

function truncateText(value, maxLength = 180) {
  const text = String(value || '').trim();
  if (text.length <= maxLength) {
    return text;
  }

  return `${text.slice(0, Math.max(0, maxLength - 3))}...`;
}

function renderCycleSummaryForConsole(cycleSummary) {
  const stats = cycleSummary.collectionStats || {};
  const lines = [
    '',
    `Homepage cycle | source=${cycleSummary.source}`,
    `Stats: collected=${cycleSummary.totalCollected} stop_reason=${stats.stopReason || 'n/a'} elapsed_seconds=${stats.elapsedSeconds ?? 'n/a'} scroll_passes=${stats.scrollPasses ?? 'n/a'} stable_passes=${stats.stablePassesReached ?? 'n/a'}/${stats.stablePassesTarget ?? 'n/a'} new=${cycleSummary.outcomeCounts?.new ?? 0} existing_same=${cycleSummary.outcomeCounts?.existing_same ?? 0} existing_updated=${cycleSummary.outcomeCounts?.existing_updated ?? 0}`,
    'Card Text:',
  ];

  for (const [index, item] of (cycleSummary.items || []).entries()) {
    lines.push(`${index + 1}. ${truncateText(item.cardText || item.cardTitle || item.href || '')}`);
  }

  if ((cycleSummary.items || []).length === 0) {
    lines.push('(no items)');
  }

  return `${lines.join('\n')}\n`;
}

async function runCycle(page, db, options, lifecycle = null) {
  const countsBefore = getHomepageListingCounts(db);
  const sessionSummary = await describeFacebookMarketplaceSession(page.context(), page, {
    credentialsPath: options.credentialsPath,
    credentialsProfile: options.credentialsProfile,
  });
  const targetLabel = options.collectAll ? 'all' : String(options.maxItems);
  const cycleTargets = options.keywordTargets.length
    ? options.keywordTargets.map((target, index) => ({
      type: 'keyword',
      label: target.keyword,
      source: 'search',
      sourceKeyword: target.keyword,
      url: buildMarketplaceKeywordSearchUrl(target, options),
      options: {
        ...options,
        startUrl: buildMarketplaceKeywordSearchUrl(target, options),
        maxItems: target.maxItems || options.maxItems,
        collectAll: target.maxItems ? false : options.collectAll,
      },
      target,
      index,
    }))
    : [{
      type: 'homepage',
      label: 'homepage',
      source: 'homepage',
      sourceKeyword: '',
      url: options.startUrl,
      options,
      target: null,
      index: 0,
    }];
  appendCollectorWorkflowEvent(db, options, 'collector_cycle_started', {
    status: 'running',
    payload: {
      startUrl: options.startUrl,
      maxItems: targetLabel,
      collectAll: options.collectAll,
      targetMode: options.keywordTargets.length ? 'keyword_targets' : 'homepage',
      targetCount: cycleTargets.length,
      dbCountsBefore: countsBefore,
    },
  });
  await appendLog(
    options.logFile,
    `cycle_start url=${options.startUrl} target_mode=${options.keywordTargets.length ? 'keyword_targets' : 'homepage'} target_count=${cycleTargets.length} max_items=${targetLabel} collect_all=${options.collectAll} max_runtime_seconds=${options.maxRuntimeSeconds} loaded_email=${sessionSummary.loadedEmail || 'n/a'} signed_in_user_id=${sessionSummary.signedInUserId || 'n/a'} logged_in=${sessionSummary.loggedIn} db_pending=${countsBefore.pending} db_processing=${countsBefore.processing} db_done=${countsBefore.done} db_error=${countsBefore.error}`,
  );

  let activePage = page;
  const targetSummaries = [];
  const allItems = [];
  for (const target of cycleTargets) {
    await appendLog(
      options.logFile,
      `cycle_target_start index=${target.index + 1}/${cycleTargets.length} type=${target.type} keyword="${target.sourceKeyword}" url=${target.url} max_items=${target.options.collectAll ? 'all' : target.options.maxItems}`,
    );
    activePage = await safeGoto(activePage.context(), activePage, target.url);
    if (lifecycle) {
      lifecycle.currentPage = activePage;
    }
    await waitForMarketplaceResults(activePage, {
      timeoutMs: 20000,
      settleTimeMs: 1200,
    });

    const collection = await collectHomepageItems(activePage, target.options);
    const targetItems = collection.items.map((item) => ({
      ...item,
      source: target.source,
      source_keyword: target.sourceKeyword,
    }));
    allItems.push(...targetItems);
    targetSummaries.push({
      type: target.type,
      keyword: target.sourceKeyword,
      url: target.url,
      totalCollected: targetItems.length,
      collectionStats: collection.stats,
      parameters: target.target,
    });
    await appendLog(
      options.logFile,
      `cycle_target_done index=${target.index + 1}/${cycleTargets.length} type=${target.type} keyword="${target.sourceKeyword}" collected=${targetItems.length} stop_reason=${collection.stats.stopReason} elapsed_seconds=${collection.stats.elapsedSeconds}`,
    );
  }
  const items = allItems;
  const collectionStats = {
    stopReason: targetSummaries.map((target) => target.collectionStats.stopReason).join(',') || 'none',
    elapsedSeconds: Number(targetSummaries.reduce((sum, target) => sum + Number(target.collectionStats.elapsedSeconds || 0), 0).toFixed(3)),
    scrollPasses: targetSummaries.reduce((sum, target) => sum + Number(target.collectionStats.scrollPasses || 0), 0),
    stablePassesReached: targetSummaries.reduce((sum, target) => sum + Number(target.collectionStats.stablePassesReached || 0), 0),
    stablePassesTarget: options.stablePasses,
    runtimeLimitReached: targetSummaries.some((target) => target.collectionStats.runtimeLimitReached),
    targetMode: options.keywordTargets.length ? 'keyword_targets' : 'homepage',
    targetCount: cycleTargets.length,
    targets: targetSummaries,
  };
  const seenAt = new Date().toISOString();
  const storedResults = items.map((item) => upsertHomepageListingWithStatus(db, item, { seenAt }));
  scanPurchaseHistoryMatchesForListings(db, storedResults.map((result) => result.row.listing_id), {
    actor: 'homepage-collector',
    matchedAt: seenAt,
  });
  for (const result of storedResults) {
    appendCollectorListingEvent(db, options, result.row, {
      status: result.outcome,
      outcome: result.outcome,
    });
  }
  const outcomeCounts = summarizeUpsertOutcomes(storedResults);
  const counts = getHomepageListingCounts(db);
  const cycleSummary = {
    capturedAt: seenAt,
    source: 'homepage',
    collectAll: options.collectAll,
    session: sessionSummary,
    dbCountsBefore: countsBefore,
    totalCollected: items.length,
    collectionStats,
    targetSummaries,
    maxItemsTarget: targetLabel,
    outcomeCounts,
    counts,
    items: storedResults.map((result) => {
      const row = result.row;
      return {
        outcome: result.outcome,
        listingId: row.listing_id,
        href: row.href,
        cardTitle: row.card_title,
        cardText: row.card_text,
        detailStatus: row.detail_status,
        lastSeenRank: row.last_seen_rank,
      };
    }),
  };

  const snapshotPath = await writeCycleSnapshot(options.snapshotFile, cycleSummary);
  await appendLog(
    options.logFile,
    `cycle_done collected=${items.length} stop_reason=${collectionStats.stopReason} elapsed_seconds=${collectionStats.elapsedSeconds} scroll_passes=${collectionStats.scrollPasses} stable_passes=${collectionStats.stablePassesReached}/${collectionStats.stablePassesTarget} runtime_limit_reached=${collectionStats.runtimeLimitReached} new=${outcomeCounts.new} existing_same=${outcomeCounts.existing_same} existing_updated=${outcomeCounts.existing_updated} loaded_email=${sessionSummary.loadedEmail || 'n/a'} signed_in_user_id=${sessionSummary.signedInUserId || 'n/a'} logged_in=${sessionSummary.loggedIn} db_pending=${counts.pending} db_processing=${counts.processing} db_done=${counts.done} db_error=${counts.error} snapshot=${snapshotPath}`,
  );
  appendCollectorWorkflowEvent(db, options, 'collector_cycle_completed', {
    status: 'completed',
    payload: {
      observedCount: items.length,
      newCount: outcomeCounts.new,
      existingSameCount: outcomeCounts.existing_same,
      existingUpdatedCount: outcomeCounts.existing_updated,
      snapshotPath,
      stopReason: collectionStats.stopReason,
      elapsedSeconds: collectionStats.elapsedSeconds,
      dbCountsAfter: counts,
    },
  });

  return {
    page: activePage,
    cycleSummary,
  };
}

async function sleep(ms) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

function computeJitteredRefreshMs(refreshSeconds, jitterMin, jitterMax) {
  const baseMs = refreshSeconds * 1000;
  const multiplier = jitterMin + (Math.random() * (jitterMax - jitterMin));
  return {
    multiplier,
    refreshMs: Math.max(0, Math.round(baseMs * multiplier)),
  };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  await ensureDir(path.dirname(options.logFile));
  await ensureDir(options.workerScreenshotDir);
  await appendLog(
    options.logFile,
    `collector_start db_path=${options.dbPath} refresh_seconds=${options.refreshSeconds} refresh_jitter_min=${options.refreshJitterMin} refresh_jitter_max=${options.refreshJitterMax} target_mode=${options.keywordTargets.length ? 'keyword_targets' : 'homepage'} keyword_targets=${options.keywordTargets.length} max_items=${options.collectAll ? 'all' : options.maxItems} collect_all=${options.collectAll} first_load_only=${options.firstLoadOnly} initial_load_wait_ms=${options.initialLoadWaitMs} headless=${options.headless} location="${options.location || ''}" radius_miles=${options.radiusMiles} auth_mode=${options.authMode} use_credentials=${options.useCredentials} worker_id=${options.workerId} worker_screenshot_interval_seconds=${options.workerScreenshotIntervalSeconds} worker_screenshot_history_limit=${options.workerScreenshotHistoryLimit} worker_screenshot_format=${options.workerScreenshotFormat} worker_screenshot_quality=${options.workerScreenshotQuality}`,
  );

  const { db } = openMarketplaceHomepageDatabase(options.dbPath);
  const resolvedUserDataDir = path.isAbsolute(options.userDataDir)
    ? options.userDataDir
    : path.join(process.cwd(), options.userDataDir);

  appendCollectorWorkflowEvent(db, options, 'worker_started', {
    status: 'running',
    payload: {
      mode: options.once ? 'once' : 'continuous',
      refreshSeconds: options.refreshSeconds,
      maxItems: options.collectAll ? 'all' : options.maxItems,
      collectAll: options.collectAll,
      targetMode: options.keywordTargets.length ? 'keyword_targets' : 'homepage',
      keywordTargets: options.keywordTargets.length,
    },
  });
  appendCollectorWorkflowEvent(db, options, 'browser_context_launch_started', {
    status: 'starting',
    payload: {
      userDataDir: resolvedUserDataDir,
      headless: options.headless,
    },
  });
  const context = await chromium.launchPersistentContext(resolvedUserDataDir, buildChromiumLaunchOptions({
    headless: options.headless,
    viewport: { width: 1440, height: 1200 },
  }));
  appendCollectorWorkflowEvent(db, options, 'browser_context_ready', {
    status: 'running',
    payload: {
      userDataDir: resolvedUserDataDir,
      headless: options.headless,
    },
  });

  const lifecycle = {
    shutdownRequested: false,
    currentPage: null,
  };
  let stopScreenshotMonitor = () => {};
  try {
    let page = await ensureFacebookMarketplaceLogin(context, {
      startUrl: options.startUrl,
      useCredentials: options.useCredentials,
      authMode: options.authMode,
      credentialsPath: options.credentialsPath,
      credentialsProfile: options.credentialsProfile,
      loginTimeoutMs: options.loginTimeoutMs,
      logger: log,
    });
    lifecycle.currentPage = page;
    stopScreenshotMonitor = startWorkerScreenshotMonitor(options, lifecycle, {
      log: (message) => appendLog(options.logFile, message),
    });
    const knownLocationArea = getKnownMarketplaceAreaFromLocation(options.location);
    if (knownLocationArea) {
      log(`location_change_skip reason=known_route location="${options.location}" area=${knownLocationArea} url=${page.url()}`);
    } else {
      page = await setMarketplaceLocation(page, {
        location: options.location,
        fallbackArea: '',
        allowMissingControl: true,
        logger: log,
      });
    }
    lifecycle.currentPage = page;
    page = await setMarketplaceRadius(page, {
      radiusMiles: options.radiusMiles,
      logger: log,
    });
    lifecycle.currentPage = page;
    const initialSessionSummary = await describeFacebookMarketplaceSession(context, page, {
      credentialsPath: options.credentialsPath,
      credentialsProfile: options.credentialsProfile,
    });
    const initialCounts = getHomepageListingCounts(db);
    appendCollectorWorkflowEvent(db, options, 'session_ready', {
      status: initialSessionSummary.loggedIn && initialSessionSummary.signedInUserId ? 'authenticated' : 'unauthenticated',
      payload: {
        loggedIn: initialSessionSummary.loggedIn,
        signedInUserId: initialSessionSummary.signedInUserId || '',
        currentUrl: initialSessionSummary.currentUrl || '',
        loadedEmail: initialSessionSummary.loadedEmail || '',
      },
    });
    await appendLog(
      options.logFile,
      `collector_session_ready loaded_email=${initialSessionSummary.loadedEmail || 'n/a'} signed_in_user_id=${initialSessionSummary.signedInUserId || 'n/a'} logged_in=${initialSessionSummary.loggedIn} current_url=${initialSessionSummary.currentUrl || 'n/a'} db_pending=${initialCounts.pending} db_processing=${initialCounts.processing} db_done=${initialCounts.done} db_error=${initialCounts.error}`,
    );
    do {
      const cycleStartedAt = Date.now();
      const result = await runCycle(page, db, options, lifecycle);
      page = result.page;
      lifecycle.currentPage = page;
      process.stdout.write(renderCycleSummaryForConsole(result.cycleSummary));

      if (options.once) {
        await appendLog(options.logFile, 'collector_exit mode=once');
        appendCollectorWorkflowEvent(db, options, 'worker_completed', {
          status: 'completed',
          payload: {
            reason: 'once',
            observedCount: result.cycleSummary.totalCollected,
          },
        });
        break;
      }

      const { multiplier, refreshMs } = computeJitteredRefreshMs(
        options.refreshSeconds,
        options.refreshJitterMin,
        options.refreshJitterMax,
      );
      const waitMs = Math.max(0, refreshMs - (Date.now() - cycleStartedAt));
      appendCollectorWorkflowEvent(db, options, 'worker_sleeping', {
        status: 'sleeping',
        payload: {
          seconds: Math.ceil(waitMs / 1000),
          reason: 'refresh_interval',
          jitterMultiplier: Number(multiplier.toFixed(3)),
        },
      });
      await appendLog(
        options.logFile,
        `collector_sleep seconds=${Math.ceil(waitMs / 1000)} base_refresh_seconds=${options.refreshSeconds} jitter_multiplier=${multiplier.toFixed(3)}`,
      );
      await sleep(waitMs);
    } while (true);
  } catch (error) {
    appendCollectorWorkflowEvent(db, options, 'worker_failed', {
      status: 'error',
      error,
      payload: {
        reason: error instanceof Error ? error.message : String(error),
      },
    });
    throw error;
  } finally {
    lifecycle.shutdownRequested = true;
    stopScreenshotMonitor();
    appendCollectorWorkflowEvent(db, options, 'browser_context_closing', {
      status: 'stopping',
      payload: {
        reason: 'worker_exit',
      },
    });
    await context.close().catch(() => {});
    appendCollectorWorkflowEvent(db, options, 'browser_context_closed', {
      status: 'stopped',
      payload: {
        reason: 'worker_exit',
      },
    });
    closeMarketplaceHomepageDatabase(db);
  }
}

if (require.main === module) {
  main().catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`[${new Date().toISOString()}] collect_marketplace_homepage_error ${message}\n`);
    console.error(message);
    process.exit(1);
  });
}

module.exports = {
  buildMarketplaceKeywordSearchUrl,
  parseArgs,
  parseKeywordTargets,
};
