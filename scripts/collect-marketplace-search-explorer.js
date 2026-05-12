const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');
const {
  buildChromiumLaunchOptions,
  inferMarketplaceAreaFromLocation,
  createLogger,
  ensureDir,
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
  normalizeKeyword,
  openMarketplaceHomepageDatabase,
  closeMarketplaceHomepageDatabase,
  upsertHomepageListingWithStatus,
  getHomepageListingCounts,
  upsertListingSearchKeyword,
  upsertSearchTitleBagKeyword,
  pickRandomSearchTitleBagKeyword,
  getSearchTitleBagCounts,
} = require('./marketplace-homepage-db');
const {
  DEFAULT_CREDENTIALS_PATH,
  DEFAULT_LOGIN_TIMEOUT_MS,
  ensureFacebookMarketplaceLogin,
  describeFacebookMarketplaceSession,
  normalizeAuthMode,
} = require('./marketplace-profile-auth');

const DEFAULT_AREA = 'vancouver';
const DEFAULT_SEARCH_URL_TEMPLATE = 'https://www.facebook.com/marketplace/%AREA%/search/?query=%QUERY%';
const log = createLogger('collect-marketplace-search-explorer');

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
  const options = {
    query: '',
    area: DEFAULT_AREA,
    areaExplicit: false,
    location: '',
    radiusMiles: 0,
    searchUrlTemplate: DEFAULT_SEARCH_URL_TEMPLATE,
    userDataDir: path.join(process.cwd(), 'profiles', 'facebook-marketplace'),
    dbPath: DEFAULT_DB_PATH,
    logFile: path.join(process.cwd(), 'artifacts', 'marketplace-homepage', 'search-explorer.log'),
    snapshotFile: path.join(process.cwd(), 'artifacts', 'marketplace-homepage', 'search-explorer-latest-cycle.json'),
    maxItems: 250,
    collectAll: true,
    firstLoadOnly: false,
    initialLoadWaitMs: 5000,
    maxRuntimeSeconds: 180,
    stablePasses: 3,
    refreshSeconds: 5 * 60,
    refreshJitterMin: 0.25,
    refreshJitterMax: 1.5,
    once: false,
    headless: true,
    useCredentials: false,
    authMode: '',
    credentialsPath: DEFAULT_CREDENTIALS_PATH,
    loginTimeoutMs: DEFAULT_LOGIN_TIMEOUT_MS,
    reseedRoundMin: 10,
    reseedRoundMax: 20,
    bagMinKeywordLength: 5,
    bagMaxKeywordLength: 160,
    bagMinTimesSeen: 1,
    includeSeedInBag: true,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    switch (arg) {
      case '--query':
        options.query = readFlagValue(argv, index, arg);
        index += 1;
        break;
      case '--area':
        options.area = readFlagValue(argv, index, arg);
        options.areaExplicit = true;
        index += 1;
        break;
      case '--location':
        options.location = readFlagValue(argv, index, arg);
        index += 1;
        break;
      case '--radius-miles':
        options.radiusMiles = parseIntegerFlag(readFlagValue(argv, index, arg), arg, 1);
        index += 1;
        break;
      case '--search-url-template':
        options.searchUrlTemplate = readFlagValue(argv, index, arg);
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
        options.collectAll = false;
        index += 1;
        break;
      case '--collect-all':
        options.collectAll = true;
        break;
      case '--no-collect-all':
        options.collectAll = false;
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
      case '--login-timeout-seconds':
        options.loginTimeoutMs = parseIntegerFlag(readFlagValue(argv, index, arg), arg, 1) * 1000;
        index += 1;
        break;
      case '--headed':
        options.headless = false;
        break;
      case '--headless':
        options.headless = true;
        break;
      case '--reseed-round-min':
        options.reseedRoundMin = parseIntegerFlag(readFlagValue(argv, index, arg), arg, 1);
        index += 1;
        break;
      case '--reseed-round-max':
        options.reseedRoundMax = parseIntegerFlag(readFlagValue(argv, index, arg), arg, 1);
        index += 1;
        break;
      case '--bag-min-keyword-length':
        options.bagMinKeywordLength = parseIntegerFlag(readFlagValue(argv, index, arg), arg, 1);
        index += 1;
        break;
      case '--bag-max-keyword-length':
        options.bagMaxKeywordLength = parseIntegerFlag(readFlagValue(argv, index, arg), arg, 1);
        index += 1;
        break;
      case '--bag-min-times-seen':
        options.bagMinTimesSeen = parseIntegerFlag(readFlagValue(argv, index, arg), arg, 1);
        index += 1;
        break;
      case '--exclude-seed-from-bag':
        options.includeSeedInBag = false;
        break;
      default:
        if (!arg.startsWith('--') && !options.query) {
          options.query = arg;
          break;
        }

        throw new Error(`Unknown argument: ${arg}`);
    }
  }

  options.query = normalizeKeyword(options.query);
  if (!options.query) {
    throw new Error('Missing required search keyword. Pass --query "<keyword>".');
  }

  options.location = cleanText(options.location);
  if (!options.areaExplicit && options.location) {
    options.area = inferMarketplaceAreaFromLocation(options.location) || DEFAULT_AREA;
  }

  if (options.refreshJitterMax < options.refreshJitterMin) {
    throw new Error('Expected --refresh-jitter-max to be >= --refresh-jitter-min');
  }
  options.authMode = normalizeAuthMode(options.authMode, options.useCredentials);

  if (options.reseedRoundMax < options.reseedRoundMin) {
    throw new Error('Expected --reseed-round-max to be >= --reseed-round-min');
  }

  if (options.bagMaxKeywordLength < options.bagMinKeywordLength) {
    throw new Error('Expected --bag-max-keyword-length to be >= --bag-min-keyword-length');
  }

  return options;
}

async function appendLog(logFile, message) {
  const line = `[${new Date().toISOString()}] ${message}\n`;
  process.stdout.write(line);
  await ensureDir(path.dirname(logFile));
  await fs.promises.appendFile(logFile, line, 'utf8');
}

function buildSearchUrl(area, query, template = DEFAULT_SEARCH_URL_TEMPLATE) {
  return String(template)
    .replace('%AREA%', encodeURIComponent(String(area || DEFAULT_AREA)))
    .replace('%QUERY%', encodeURIComponent(String(query || '')));
}

function isPriceLine(line) {
  return /^(?:CA\$|\$)\s?[\d,]+(?:\.\d{2})?$/.test(line);
}

function isFreshnessLine(line) {
  return /^(?:just listed|new listing|today|yesterday|刚刚上架|刚刚发布|listed .* ago)$/i.test(line);
}

function pickSearchCardTitle(lines) {
  const preferred = lines.find((line) => !isPriceLine(line) && !isFreshnessLine(line));
  return preferred || lines[0] || '';
}

async function readSearchResultItems(page) {
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
          lines,
          text: lines.join(' | '),
        };
      })
      .filter(Boolean);
  });
}

async function collectSearchItems(page, options) {
  const startedAt = Date.now();
  const itemsByListingId = new Map();
  let stableCount = 0;
  let firstPass = true;
  let scrollPasses = 0;
  let readPasses = 0;
  const targetLabel = options.collectAll ? 'all' : String(options.maxItems);
  let stopReason = 'unknown';

  while (
    (options.collectAll || itemsByListingId.size < options.maxItems)
    && (Date.now() - startedAt) < (options.maxRuntimeSeconds * 1000)
  ) {
    readPasses += 1;
    const visibleItems = await readSearchResultItems(page);
    for (const item of visibleItems) {
      const href = canonicalizeListingUrl(item.href);
      const listingId = item.listingId || extractListingId(href) || href;
      if (!itemsByListingId.has(listingId)) {
        itemsByListingId.set(listingId, {
          listingId,
          href,
          title: cleanText(pickSearchCardTitle(item.lines || [])),
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

    const afterScrollItems = await readSearchResultItems(page);
    for (const item of afterScrollItems) {
      const href = canonicalizeListingUrl(item.href);
      const listingId = item.listingId || extractListingId(href) || href;
      if (!itemsByListingId.has(listingId)) {
        itemsByListingId.set(listingId, {
          listingId,
          href,
          title: cleanText(pickSearchCardTitle(item.lines || [])),
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

function filterBagKeywordsFromItems(items, options) {
  return items
    .map((item) => normalizeKeyword(item.title))
    .filter((title) => title.length >= options.bagMinKeywordLength)
    .filter((title) => title.length <= options.bagMaxKeywordLength);
}

function randomIntegerBetween(minimum, maximum) {
  if (maximum <= minimum) {
    return minimum;
  }

  return minimum + Math.floor(Math.random() * ((maximum - minimum) + 1));
}

function computeNextSeedRound(currentRound, reseedRoundMin, reseedRoundMax) {
  return currentRound + randomIntegerBetween(reseedRoundMin, reseedRoundMax);
}

function computeJitteredRefreshMs(refreshSeconds, jitterMin, jitterMax) {
  const baseMs = refreshSeconds * 1000;
  const multiplier = jitterMin + (Math.random() * (jitterMax - jitterMin));
  return {
    multiplier,
    refreshMs: Math.max(0, Math.round(baseMs * multiplier)),
  };
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
    `Search round ${cycleSummary.roundNumber} | query="${cycleSummary.sourceKeyword}" | query_source=${cycleSummary.querySource}`,
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

async function chooseRoundQuery(db, state, options) {
  if (state.roundNumber === 1 || state.roundNumber >= state.nextSeedRound) {
    const reseedRound = computeNextSeedRound(
      state.roundNumber,
      options.reseedRoundMin,
      options.reseedRoundMax,
    );
    return {
      query: options.query,
      querySource: 'seed',
      nextSeedRound: reseedRound,
      bagKeyword: null,
    };
  }

  const bagKeyword = pickRandomSearchTitleBagKeyword(db, {
    minTimesSeen: options.bagMinTimesSeen,
  });

  if (!bagKeyword) {
    return {
      query: options.query,
      querySource: 'seed_fallback',
      nextSeedRound: state.nextSeedRound,
      bagKeyword: null,
    };
  }

  return {
    query: bagKeyword.keyword,
    querySource: 'bag',
    nextSeedRound: state.nextSeedRound,
    bagKeyword,
  };
}

async function runRound(page, db, options, state) {
  const countsBefore = getHomepageListingCounts(db);
  const bagCountsBefore = getSearchTitleBagCounts(db);
  const sessionSummary = await describeFacebookMarketplaceSession(page.context(), page, {
    credentialsPath: options.credentialsPath,
  });
  const queryPlan = await chooseRoundQuery(db, state, options);
  const searchUrl = buildSearchUrl(options.area, queryPlan.query, options.searchUrlTemplate);
  const targetLabel = options.collectAll ? 'all' : String(options.maxItems);

  await appendLog(
    options.logFile,
    `round_start round=${state.roundNumber} query_source=${queryPlan.querySource} query="${queryPlan.query}" next_seed_round=${queryPlan.nextSeedRound} area=${options.area} max_items=${targetLabel} collect_all=${options.collectAll} loaded_email=${sessionSummary.loadedEmail || 'n/a'} signed_in_user_id=${sessionSummary.signedInUserId || 'n/a'} logged_in=${sessionSummary.loggedIn} bag_keywords=${bagCountsBefore.totalKeywords} db_pending=${countsBefore.pending} db_processing=${countsBefore.processing} db_done=${countsBefore.done} db_error=${countsBefore.error}`,
  );

  const activePage = await safeGoto(page.context(), page, searchUrl);
  await waitForMarketplaceResults(activePage, {
    timeoutMs: 20000,
    settleTimeMs: 1200,
  });

  const collection = await collectSearchItems(activePage, options);
  const { items, stats: collectionStats } = collection;
  const seenAt = new Date().toISOString();
  const storedResults = items.map((item) => {
    const result = upsertHomepageListingWithStatus(db, item, {
      seenAt,
      source: 'search',
      sourceKeyword: queryPlan.query,
    });
    upsertListingSearchKeyword(db, result.row.listing_id, queryPlan.query, { seenAt });
    return result;
  });

  const bagKeywords = filterBagKeywordsFromItems(items, options);
  if (options.includeSeedInBag) {
    bagKeywords.push(queryPlan.query);
  }
  for (const keyword of bagKeywords) {
    upsertSearchTitleBagKeyword(db, keyword, {
      seenAt,
      sourceKeyword: queryPlan.query,
    });
  }

  const outcomeCounts = summarizeUpsertOutcomes(storedResults);
  const counts = getHomepageListingCounts(db);
  const bagCounts = getSearchTitleBagCounts(db);
  const cycleSummary = {
    capturedAt: seenAt,
    source: 'search',
    sourceKeyword: queryPlan.query,
    querySource: queryPlan.querySource,
    roundNumber: state.roundNumber,
    nextSeedRound: queryPlan.nextSeedRound,
    area: options.area,
    collectAll: options.collectAll,
    session: sessionSummary,
    dbCountsBefore: countsBefore,
    dbCountsAfter: counts,
    titleBagCountsBefore: bagCountsBefore,
    titleBagCountsAfter: bagCounts,
    totalCollected: items.length,
    collectionStats,
    maxItemsTarget: targetLabel,
    outcomeCounts,
    items: storedResults.map((result) => ({
      outcome: result.outcome,
      listingId: result.row.listing_id,
      href: result.row.href,
      source: result.row.source,
      sourceKeyword: result.row.source_keyword,
      cardTitle: result.row.card_title,
      cardText: result.row.card_text,
      detailStatus: result.row.detail_status,
      lastSeenRank: result.row.last_seen_rank,
    })),
  };

  const snapshotPath = await writeCycleSnapshot(options.snapshotFile, cycleSummary);
  await appendLog(
    options.logFile,
    `round_done round=${state.roundNumber} query_source=${queryPlan.querySource} query="${queryPlan.query}" collected=${items.length} stop_reason=${collectionStats.stopReason} elapsed_seconds=${collectionStats.elapsedSeconds} scroll_passes=${collectionStats.scrollPasses} stable_passes=${collectionStats.stablePassesReached}/${collectionStats.stablePassesTarget} runtime_limit_reached=${collectionStats.runtimeLimitReached} bag_added=${bagKeywords.length} new=${outcomeCounts.new} existing_same=${outcomeCounts.existing_same} existing_updated=${outcomeCounts.existing_updated} bag_keywords=${bagCounts.totalKeywords} db_pending=${counts.pending} db_processing=${counts.processing} db_done=${counts.done} db_error=${counts.error} snapshot=${snapshotPath}`,
  );

  state.nextSeedRound = queryPlan.nextSeedRound;
  state.lastQuery = queryPlan.query;

  return {
    page: activePage,
    cycleSummary,
  };
}

async function sleep(ms) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  await ensureDir(path.dirname(options.logFile));
  await appendLog(
    options.logFile,
    `search_explorer_start db_path=${options.dbPath} seed_query="${options.query}" area=${options.area} location="${options.location || ''}" radius_miles=${options.radiusMiles} refresh_seconds=${options.refreshSeconds} refresh_jitter_min=${options.refreshJitterMin} refresh_jitter_max=${options.refreshJitterMax} reseed_round_min=${options.reseedRoundMin} reseed_round_max=${options.reseedRoundMax} max_items=${options.collectAll ? 'all' : options.maxItems} collect_all=${options.collectAll} first_load_only=${options.firstLoadOnly} initial_load_wait_ms=${options.initialLoadWaitMs} headless=${options.headless} auth_mode=${options.authMode} use_credentials=${options.useCredentials}`,
  );

  const { db } = openMarketplaceHomepageDatabase(options.dbPath);
  const resolvedUserDataDir = path.isAbsolute(options.userDataDir)
    ? options.userDataDir
    : path.join(process.cwd(), options.userDataDir);
  const context = await chromium.launchPersistentContext(resolvedUserDataDir, buildChromiumLaunchOptions({
    headless: options.headless,
    viewport: { width: 1440, height: 1200 },
  }));

  try {
    let page = await ensureFacebookMarketplaceLogin(context, {
      startUrl: buildSearchUrl(options.area, options.query, options.searchUrlTemplate),
      useCredentials: options.useCredentials,
      authMode: options.authMode,
      credentialsPath: options.credentialsPath,
      loginTimeoutMs: options.loginTimeoutMs,
      logger: log,
    });
    page = await setMarketplaceLocation(page, {
      location: options.location,
      fallbackArea: options.area,
      allowMissingControl: true,
      logger: log,
    });
    page = await setMarketplaceRadius(page, {
      radiusMiles: options.radiusMiles,
      logger: log,
    });
    const initialSessionSummary = await describeFacebookMarketplaceSession(context, page, {
      credentialsPath: options.credentialsPath,
    });
    const initialCounts = getHomepageListingCounts(db);
    const initialBagCounts = getSearchTitleBagCounts(db);
    await appendLog(
      options.logFile,
      `search_explorer_session_ready loaded_email=${initialSessionSummary.loadedEmail || 'n/a'} signed_in_user_id=${initialSessionSummary.signedInUserId || 'n/a'} logged_in=${initialSessionSummary.loggedIn} current_url=${initialSessionSummary.currentUrl || 'n/a'} bag_keywords=${initialBagCounts.totalKeywords} db_pending=${initialCounts.pending} db_processing=${initialCounts.processing} db_done=${initialCounts.done} db_error=${initialCounts.error}`,
    );

    const state = {
      roundNumber: 1,
      nextSeedRound: 1,
      lastQuery: '',
    };

    do {
      const roundStartedAt = Date.now();
      const result = await runRound(page, db, options, state);
      page = result.page;
      process.stdout.write(renderCycleSummaryForConsole(result.cycleSummary));

      if (options.once) {
        await appendLog(options.logFile, 'search_explorer_exit mode=once');
        break;
      }

      state.roundNumber += 1;
      const { multiplier, refreshMs } = computeJitteredRefreshMs(
        options.refreshSeconds,
        options.refreshJitterMin,
        options.refreshJitterMax,
      );
      const waitMs = Math.max(0, refreshMs - (Date.now() - roundStartedAt));
      await appendLog(
        options.logFile,
        `search_explorer_sleep seconds=${Math.ceil(waitMs / 1000)} base_refresh_seconds=${options.refreshSeconds} jitter_multiplier=${multiplier.toFixed(3)} next_round=${state.roundNumber} next_seed_round=${state.nextSeedRound}`,
      );
      await sleep(waitMs);
    } while (true);
  } finally {
    closeMarketplaceHomepageDatabase(db);
    await context.close();
  }
}

if (require.main === module) {
  main().catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`[${new Date().toISOString()}] collect_marketplace_search_explorer_error ${message}\n`);
    console.error(message);
    process.exit(1);
  });
}

module.exports = {
  parseArgs,
  buildSearchUrl,
  pickSearchCardTitle,
  filterBagKeywordsFromItems,
  computeNextSeedRound,
  chooseRoundQuery,
};
