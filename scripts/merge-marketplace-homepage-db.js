const fs = require('fs');
const path = require('path');

const {
  DEFAULT_DB_PATH,
  openMarketplaceHomepageDatabase,
  closeMarketplaceHomepageDatabase,
  runTransaction,
} = require('./marketplace-homepage-db');

const TERMINAL_DETAIL_STATUSES = ['done', 'sold', 'pending_sale'];
const DEFAULT_IMPORT_STATUSES = TERMINAL_DETAIL_STATUSES;
const MEDIA_PATH_KEYS = new Set(['screenshotPath', 'snapshotPath', 'screenshot_path', 'snapshot_path']);

function readFlagValue(argv, index, flagName) {
  const value = argv[index + 1];
  if (!value || value.startsWith('--')) {
    throw new Error(`Missing value for ${flagName}`);
  }
  return value;
}

function parseRewritePrefix(value) {
  const separatorIndex = String(value || '').indexOf('=');
  if (separatorIndex <= 0) {
    throw new Error('Expected --rewrite-prefix to use from=to');
  }
  return {
    from: value.slice(0, separatorIndex),
    to: value.slice(separatorIndex + 1),
  };
}

function parseArgs(argv) {
  const options = {
    sourceDbPath: '',
    targetDbPath: DEFAULT_DB_PATH,
    statuses: DEFAULT_IMPORT_STATUSES,
    dryRun: true,
    includeResolvedListings: true,
    includeListingEvents: true,
    includeWorkflowEvents: true,
    clearMediaPaths: true,
    rewritePrefixes: [],
    json: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    switch (arg) {
      case '--source-db':
        options.sourceDbPath = readFlagValue(argv, index, arg);
        index += 1;
        break;
      case '--target-db':
      case '--db-path':
        options.targetDbPath = readFlagValue(argv, index, arg);
        index += 1;
        break;
      case '--statuses':
        options.statuses = readFlagValue(argv, index, arg)
          .split(',')
          .map((item) => item.trim())
          .filter(Boolean);
        index += 1;
        break;
      case '--execute':
        options.dryRun = false;
        break;
      case '--dry-run':
        options.dryRun = true;
        break;
      case '--no-resolved-listings':
        options.includeResolvedListings = false;
        break;
      case '--no-listing-events':
        options.includeListingEvents = false;
        break;
      case '--no-workflow-events':
        options.includeWorkflowEvents = false;
        break;
      case '--preserve-media-paths':
        options.clearMediaPaths = false;
        break;
      case '--clear-media-paths':
        options.clearMediaPaths = true;
        break;
      case '--rewrite-prefix':
        options.rewritePrefixes.push(parseRewritePrefix(readFlagValue(argv, index, arg)));
        options.clearMediaPaths = false;
        index += 1;
        break;
      case '--json':
        options.json = true;
        break;
      default:
        throw new Error(`Unknown argument: ${arg}`);
    }
  }

  if (!options.sourceDbPath) {
    throw new Error('Missing required --source-db');
  }
  if (!options.statuses.length) {
    throw new Error('Expected at least one --statuses value');
  }
  for (const status of options.statuses) {
    if (!TERMINAL_DETAIL_STATUSES.includes(status)) {
      throw new Error(`Unsupported import status: ${status}`);
    }
  }

  return options;
}

function resolveDbPath(dbPath) {
  return path.isAbsolute(dbPath) ? dbPath : path.join(process.cwd(), dbPath);
}

function getTableColumns(db, tableName) {
  return db.prepare(`PRAGMA table_info(${tableName})`).all().map((row) => row.name);
}

function rewriteStringValue(value, rewritePrefixes) {
  let next = String(value);
  for (const prefix of rewritePrefixes) {
    if (prefix.from && next.startsWith(prefix.from)) {
      next = `${prefix.to}${next.slice(prefix.from.length)}`;
    }
  }
  return next;
}

function scrubOrRewriteJsonValue(value, options) {
  if (Array.isArray(value)) {
    return value.map((item) => scrubOrRewriteJsonValue(item, options));
  }
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, child]) => {
      if (options.clearMediaPaths && MEDIA_PATH_KEYS.has(key)) {
        return [key, ''];
      }
      return [key, scrubOrRewriteJsonValue(child, options)];
    }));
  }
  if (typeof value === 'string' && !options.clearMediaPaths) {
    return rewriteStringValue(value, options.rewritePrefixes);
  }
  return value;
}

function transformJsonText(rawJson, options) {
  const text = String(rawJson || '{}').trim() || '{}';
  try {
    return JSON.stringify(scrubOrRewriteJsonValue(JSON.parse(text), options));
  } catch {
    return text;
  }
}

function transformMediaPath(value, options) {
  const text = String(value || '').trim();
  if (!text) return '';
  if (options.clearMediaPaths) return '';
  return rewriteStringValue(text, options.rewritePrefixes);
}

function normalizeHomepageListingRow(row, options) {
  return {
    ...row,
    claimed_by: '',
    detail_json: transformJsonText(row.detail_json, options),
    screenshot_path: transformMediaPath(row.screenshot_path, options),
    snapshot_path: transformMediaPath(row.snapshot_path, options),
  };
}

function normalizeListingEventRow(row, options) {
  return {
    ...row,
    content_json: transformJsonText(row.content_json, options),
    screenshot_path: transformMediaPath(row.screenshot_path, options),
    snapshot_path: transformMediaPath(row.snapshot_path, options),
  };
}

function normalizeWorkflowEventRow(row, options) {
  return {
    ...row,
    content_json: transformJsonText(row.content_json, options),
  };
}

function isSourceDetailNewer(sourceRow, targetRow) {
  const sourceCompletedAt = Date.parse(sourceRow.detail_completed_at || '');
  const targetCompletedAt = Date.parse(targetRow.detail_completed_at || '');
  if (!Number.isFinite(targetCompletedAt)) return true;
  if (!Number.isFinite(sourceCompletedAt)) return false;
  return sourceCompletedAt > targetCompletedAt;
}

function buildInsertStatement(db, tableName, columns) {
  const columnList = columns.map((column) => `"${column}"`).join(', ');
  const placeholders = columns.map(() => '?').join(', ');
  return db.prepare(`INSERT OR IGNORE INTO ${tableName} (${columnList}) VALUES (${placeholders})`);
}

function buildHomepageUpdateStatement(db) {
  const detailColumns = [
    'detail_status',
    'detail_attempts',
    'detail_last_error',
    'detail_started_at',
    'detail_completed_at',
    'claimed_by',
    'detail_title',
    'detail_price',
    'detail_location',
    'detail_condition',
    'detail_listed_ago',
    'detail_seller_name',
    'detail_json',
    'screenshot_path',
    'snapshot_path',
  ];
  const setClause = detailColumns.map((column) => `"${column}" = ?`).join(', ');
  return {
    columns: detailColumns,
    statement: db.prepare(`UPDATE homepage_listings SET ${setClause} WHERE listing_id = ?`),
  };
}

function rowValues(row, columns) {
  return columns.map((column) => row[column]);
}

function countRows(db, tableName) {
  return db.prepare(`SELECT COUNT(*) AS count FROM ${tableName}`).get().count;
}

function checkpointWal(db) {
  try {
    return db.prepare('PRAGMA wal_checkpoint(PASSIVE)').all();
  } catch {
    return [];
  }
}

function selectResolvedRows(db, statuses) {
  const placeholders = statuses.map(() => '?').join(', ');
  return db.prepare(`
    SELECT *
    FROM homepage_listings
    WHERE detail_status IN (${placeholders})
  `).all(...statuses);
}

function selectAllRows(db, tableName) {
  return db.prepare(`SELECT * FROM ${tableName}`).all();
}

function mergeResolvedListings(sourceDb, targetDb, options) {
  const sourceRows = selectResolvedRows(sourceDb, options.statuses);
  const targetColumns = getTableColumns(targetDb, 'homepage_listings');
  const insertListing = buildInsertStatement(targetDb, 'homepage_listings', targetColumns);
  const updateListing = buildHomepageUpdateStatement(targetDb);
  const getTargetListing = targetDb.prepare('SELECT * FROM homepage_listings WHERE listing_id = ?');
  const summary = {
    scanned: sourceRows.length,
    inserted: 0,
    updated: 0,
    skippedTerminalNewerOrEqual: 0,
    skippedDryRun: 0,
  };

  for (const sourceRow of sourceRows) {
    const row = normalizeHomepageListingRow(sourceRow, options);
    const targetRow = getTargetListing.get(row.listing_id);
    if (!targetRow) {
      summary.inserted += 1;
      if (options.dryRun) {
        summary.skippedDryRun += 1;
        continue;
      }
      insertListing.run(...rowValues(row, targetColumns));
      continue;
    }

    if (TERMINAL_DETAIL_STATUSES.includes(targetRow.detail_status) && !isSourceDetailNewer(row, targetRow)) {
      summary.skippedTerminalNewerOrEqual += 1;
      continue;
    }

    summary.updated += 1;
    if (options.dryRun) {
      summary.skippedDryRun += 1;
      continue;
    }
    updateListing.statement.run(...rowValues(row, updateListing.columns), row.listing_id);
  }

  return summary;
}

function mergeListingEvents(sourceDb, targetDb, options) {
  const rows = selectAllRows(sourceDb, 'listing_events');
  const targetColumns = getTableColumns(targetDb, 'listing_events');
  const insertEvent = buildInsertStatement(targetDb, 'listing_events', targetColumns);
  const eventExists = targetDb.prepare('SELECT 1 FROM listing_events WHERE event_id = ?');
  const listingExists = targetDb.prepare('SELECT 1 FROM homepage_listings WHERE listing_id = ?');
  const summary = {
    scanned: rows.length,
    inserted: 0,
    skippedExisting: 0,
    skippedMissingListing: 0,
    skippedDryRun: 0,
  };

  for (const sourceRow of rows) {
    if (eventExists.get(sourceRow.event_id)) {
      summary.skippedExisting += 1;
      continue;
    }
    if (!listingExists.get(sourceRow.listing_id)) {
      summary.skippedMissingListing += 1;
      continue;
    }
    summary.inserted += 1;
    if (options.dryRun) {
      summary.skippedDryRun += 1;
      continue;
    }
    const row = normalizeListingEventRow(sourceRow, options);
    insertEvent.run(...rowValues(row, targetColumns));
  }

  return summary;
}

function mergeWorkflowEvents(sourceDb, targetDb, options) {
  const rows = selectAllRows(sourceDb, 'workflow_events');
  const targetColumns = getTableColumns(targetDb, 'workflow_events');
  const insertEvent = buildInsertStatement(targetDb, 'workflow_events', targetColumns);
  const eventExists = targetDb.prepare('SELECT 1 FROM workflow_events WHERE event_id = ?');
  const summary = {
    scanned: rows.length,
    inserted: 0,
    skippedExisting: 0,
    skippedDryRun: 0,
  };

  for (const sourceRow of rows) {
    if (eventExists.get(sourceRow.event_id)) {
      summary.skippedExisting += 1;
      continue;
    }
    summary.inserted += 1;
    if (options.dryRun) {
      summary.skippedDryRun += 1;
      continue;
    }
    const row = normalizeWorkflowEventRow(sourceRow, options);
    insertEvent.run(...rowValues(row, targetColumns));
  }

  return summary;
}

function mergeMarketplaceHomepageDb(rawOptions) {
  const options = {
    ...rawOptions,
    sourceDbPath: resolveDbPath(rawOptions.sourceDbPath),
    targetDbPath: resolveDbPath(rawOptions.targetDbPath),
  };
  if (!fs.existsSync(options.sourceDbPath)) {
    throw new Error(`Source DB does not exist: ${options.sourceDbPath}`);
  }
  if (!fs.existsSync(options.targetDbPath)) {
    throw new Error(`Target DB does not exist: ${options.targetDbPath}`);
  }
  if (options.sourceDbPath === options.targetDbPath) {
    throw new Error('Source DB and target DB must be different files');
  }

  const source = openMarketplaceHomepageDatabase(options.sourceDbPath);
  const target = openMarketplaceHomepageDatabase(options.targetDbPath);
  try {
    const checkpoints = {
      source: checkpointWal(source.db),
      target: checkpointWal(target.db),
    };
    const before = {
      homepageListings: countRows(target.db, 'homepage_listings'),
      listingEvents: countRows(target.db, 'listing_events'),
      workflowEvents: countRows(target.db, 'workflow_events'),
    };
    const runMerge = () => ({
      resolvedListings: options.includeResolvedListings
        ? mergeResolvedListings(source.db, target.db, options)
        : null,
      listingEvents: options.includeListingEvents
        ? mergeListingEvents(source.db, target.db, options)
        : null,
      workflowEvents: options.includeWorkflowEvents
        ? mergeWorkflowEvents(source.db, target.db, options)
        : null,
    });
    const summary = options.dryRun
      ? runMerge()
      : runTransaction(target.db, runMerge);
    const after = {
      homepageListings: countRows(target.db, 'homepage_listings'),
      listingEvents: countRows(target.db, 'listing_events'),
      workflowEvents: countRows(target.db, 'workflow_events'),
    };
    return {
      dryRun: options.dryRun,
      sourceDbPath: options.sourceDbPath,
      targetDbPath: options.targetDbPath,
      statuses: options.statuses,
      mediaMode: options.clearMediaPaths ? 'clear' : 'preserve_or_rewrite',
      checkpoints,
      before,
      summary,
      after,
    };
  } finally {
    closeMarketplaceHomepageDatabase(source.db);
    closeMarketplaceHomepageDatabase(target.db);
  }
}

function renderReport(payload) {
  const lines = [
    `Mode: ${payload.dryRun ? 'dry-run' : 'execute'}`,
    `Source: ${payload.sourceDbPath}`,
    `Target: ${payload.targetDbPath}`,
    `Statuses: ${payload.statuses.join(', ')}`,
    `Media: ${payload.mediaMode}`,
  ];
  if (payload.summary.resolvedListings) {
    const item = payload.summary.resolvedListings;
    lines.push(`Resolved listings: scanned=${item.scanned} insert=${item.inserted} update=${item.updated} skip_terminal=${item.skippedTerminalNewerOrEqual}`);
  }
  if (payload.summary.listingEvents) {
    const item = payload.summary.listingEvents;
    lines.push(`Listing events: scanned=${item.scanned} insert=${item.inserted} existing=${item.skippedExisting} missing_listing=${item.skippedMissingListing}`);
  }
  if (payload.summary.workflowEvents) {
    const item = payload.summary.workflowEvents;
    lines.push(`Workflow events: scanned=${item.scanned} insert=${item.inserted} existing=${item.skippedExisting}`);
  }
  lines.push(`Before: listings=${payload.before.homepageListings} listing_events=${payload.before.listingEvents} workflow_events=${payload.before.workflowEvents}`);
  lines.push(`After: listings=${payload.after.homepageListings} listing_events=${payload.after.listingEvents} workflow_events=${payload.after.workflowEvents}`);
  if (payload.dryRun) {
    lines.push('No changes were written. Rerun with --execute to apply.');
  }
  return lines.join('\n');
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  const payload = mergeMarketplaceHomepageDb(options);
  if (options.json) {
    console.log(JSON.stringify(payload, null, 2));
  } else {
    console.log(renderReport(payload));
  }
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  }
}

module.exports = {
  parseArgs,
  mergeMarketplaceHomepageDb,
  renderReport,
  transformJsonText,
  transformMediaPath,
};
