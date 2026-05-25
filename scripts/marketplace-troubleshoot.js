#!/usr/bin/env node
'use strict';

const {
  openMarketplaceHomepageDatabase,
  closeMarketplaceHomepageDatabase,
  resolveWorkerEventIdsForRun,
  getWorkerListingEventStats,
  listWorkerListingEvents,
  releaseHomepageListingClaim,
} = require('./marketplace-homepage-db');

const DEFAULT_DB_PATH = '/app/artifacts/marketplace-homepage/marketplace-homepage.db';

function usage(exitCode = 0) {
  const text = `
Usage:
  node scripts/marketplace-troubleshoot.js recent-workers [--limit 10] [--db-path PATH]
  node scripts/marketplace-troubleshoot.js worker --pid PID [--db-path PATH]
  node scripts/marketplace-troubleshoot.js worker --run-id RUN_ID [--db-path PATH]
  node scripts/marketplace-troubleshoot.js stuck-processing [--minutes 15] [--limit 50] [--db-path PATH]
  node scripts/marketplace-troubleshoot.js reset-processing --listing-id ID [--status pending|error] [--apply] [--db-path PATH]
  node scripts/marketplace-troubleshoot.js reset-processing --older-than-minutes N [--status pending|error] [--apply] [--limit 50] [--db-path PATH]
`;
  process[exitCode === 0 ? 'stdout' : 'stderr'].write(text.trimStart());
  process.exit(exitCode);
}

function parseArgs(argv) {
  const args = { _: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!arg.startsWith('--')) {
      args._.push(arg);
      continue;
    }
    const key = arg.slice(2);
    if (key === 'apply' || key === 'json' || key === 'help') {
      args[key] = true;
      continue;
    }
    const value = argv[index + 1];
    if (value === undefined || value.startsWith('--')) {
      throw new Error(`Expected value after ${arg}`);
    }
    args[key] = value;
    index += 1;
  }
  return args;
}

function numberArg(args, key, fallback) {
  const raw = args[key];
  if (raw === undefined || raw === '') return fallback;
  const value = Number.parseInt(raw, 10);
  if (!Number.isFinite(value)) {
    throw new Error(`Expected --${key} to be a number`);
  }
  return value;
}

function dbArg(args) {
  return args['db-path'] || process.env.MARKETPLACE_HOME_DB || DEFAULT_DB_PATH;
}

function openDb(args) {
  return openMarketplaceHomepageDatabase(dbArg(args));
}

function parseJson(value, fallback) {
  try {
    return JSON.parse(value || '');
  } catch (_) {
    return fallback;
  }
}

function short(value, max = 120) {
  const text = String(value ?? '');
  return text.length > max ? `${text.slice(0, max - 3)}...` : text;
}

function printObject(title, value) {
  if (title) console.log(`\n${title}`);
  console.log(JSON.stringify(value, null, 2));
}

function listRecentWorkers(db, args) {
  const limit = Math.max(1, Math.min(numberArg(args, 'limit', 10), 100));
  const rows = db.prepare(`
    SELECT run_id, workflow_id, label, pid, status, started_at, updated_at, exited_at,
      exit_code, signal, os_checked_at, os_alive, json_array_length(logs_json) AS log_count
    FROM workflow_runs
    ORDER BY started_at DESC
    LIMIT ?
  `).all(limit);
  printObject('Recent workers', rows);
}

function findWorkerRun(db, args) {
  if (args['run-id']) {
    return db.prepare('SELECT * FROM workflow_runs WHERE run_id = ?').get(args['run-id']);
  }
  if (args.pid) {
    return db.prepare(`
      SELECT *
      FROM workflow_runs
      WHERE pid = ?
      ORDER BY started_at DESC
      LIMIT 1
    `).get(Number.parseInt(args.pid, 10));
  }
  throw new Error('Expected --pid or --run-id');
}

function summarizeWorker(db, args) {
  const run = findWorkerRun(db, args);
  if (!run) {
    throw new Error('No workflow run matched that worker selector');
  }
  const logs = parseJson(run.logs_json, []);
  const workerIds = resolveWorkerEventIdsForRun(db, run.run_id);
  const stats = getWorkerListingEventStats(db, run.run_id, { workerIds });
  const events = listWorkerListingEvents(db, run.run_id, { category: 'all', limit: 120, workerIds });
  const listingIds = [...new Set(events.map((event) => event.listing_id).filter(Boolean))];
  const listings = listingIds.length
    ? db.prepare(`
      SELECT listing_id, detail_status, detail_attempts, detail_last_error,
        detail_started_at, detail_completed_at, card_title, detail_title, detail_price
      FROM homepage_listings
      WHERE listing_id IN (${listingIds.map(() => '?').join(',')})
      ORDER BY detail_started_at
    `).all(...listingIds)
    : [];

  printObject('Worker run', {
    run_id: run.run_id,
    workflow_id: run.workflow_id,
    label: run.label,
    script: run.script,
    pid: run.pid,
    status: run.status,
    started_at: run.started_at,
    updated_at: run.updated_at,
    exited_at: run.exited_at,
    exit_code: run.exit_code,
    signal: run.signal,
    os_checked_at: run.os_checked_at,
    os_alive: run.os_alive,
    args: parseJson(run.args_json, []),
    log_count: logs.length,
  });
  printObject('Event stats', {
    workerIds,
    total: stats.total,
    started: stats.started,
    done: stats.done,
    skipped: stats.skipped,
    error: stats.error,
    latestEvent: stats.latestEvent ? {
      event_at: stats.latestEvent.event_at,
      listing_id: stats.latestEvent.listing_id,
      event_type: stats.latestEvent.event_type,
      status: stats.latestEvent.status,
      title: stats.latestEvent.listing?.card_title || stats.latestEvent.listing?.detail_title || '',
    } : null,
  });
  printObject('Listings touched', listings.map((row, index) => ({
    index: index + 1,
    listing_id: row.listing_id,
    status: row.detail_status,
    attempts: row.detail_attempts,
    started_at: row.detail_started_at,
    completed_at: row.detail_completed_at,
    title: row.detail_title || row.card_title,
    price: row.detail_price,
    last_error: short(row.detail_last_error, 180),
  })));
  printObject('Recent events', events.slice(0, 30).map((event) => ({
    event_at: event.event_at,
    listing_id: event.listing_id,
    event_type: event.event_type,
    status: event.status,
  })));
  printObject('Log tail', logs.slice(-80));
}

function stuckProcessingRows(db, args) {
  const minutes = Math.max(1, numberArg(args, 'minutes', numberArg(args, 'older-than-minutes', 15)));
  const limit = Math.max(1, Math.min(numberArg(args, 'limit', 50), 500));
  const cutoff = new Date(Date.now() - minutes * 60 * 1000).toISOString();
  return db.prepare(`
    SELECT listing_id, detail_status, detail_attempts, detail_last_error,
      detail_started_at, detail_completed_at, claimed_by, card_title, detail_title, detail_price
    FROM homepage_listings
    WHERE detail_status = 'processing'
      AND (detail_started_at IS NULL OR detail_started_at < ?)
    ORDER BY detail_started_at ASC
    LIMIT ?
  `).all(cutoff, limit);
}

function listStuckProcessing(db, args) {
  const rows = stuckProcessingRows(db, args);
  printObject('Stuck processing listings', rows.map((row) => ({
    listing_id: row.listing_id,
    attempts: row.detail_attempts,
    started_at: row.detail_started_at,
    claimed_by: row.claimed_by,
    title: row.detail_title || row.card_title,
    price: row.detail_price,
    last_error: short(row.detail_last_error, 180),
  })));
}

function resetProcessing(db, args) {
  const status = String(args.status || 'pending');
  if (!['pending', 'error'].includes(status)) {
    throw new Error('Expected --status to be pending or error');
  }
  const apply = args.apply === true;
  let rows = [];
  if (args['listing-id']) {
    rows = db.prepare(`
      SELECT listing_id, detail_status, detail_attempts, claimed_by, card_title, detail_title
      FROM homepage_listings
      WHERE listing_id = ?
    `).all(args['listing-id']);
  } else if (args['older-than-minutes']) {
    rows = stuckProcessingRows(db, args);
  } else {
    throw new Error('Expected --listing-id or --older-than-minutes');
  }

  const eligible = rows.filter((row) => row.detail_status === 'processing');
  printObject(apply ? 'Resetting processing listings' : 'Dry run: processing listings that would be reset', eligible);
  if (!apply) {
    console.log('\nNo DB changes made. Re-run with --apply to update these rows.');
    return;
  }

  const reason = args.reason || `manual troubleshooting reset to ${status}`;
  const results = eligible.map((row) => releaseHomepageListingClaim(db, row.listing_id, {
    nextStatus: status,
    reason,
    workerId: args['worker-id'] || '',
  }));
  printObject('Updated listings', results.map((row) => ({
    listing_id: row.listing_id,
    detail_status: row.detail_status,
    detail_attempts: row.detail_attempts,
    detail_last_error: row.detail_last_error,
    detail_completed_at: row.detail_completed_at,
  })));
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help || args._.length === 0) usage(0);
  const command = args._[0];
  const { db } = openDb(args);
  try {
    if (command === 'recent-workers') {
      listRecentWorkers(db, args);
    } else if (command === 'worker') {
      summarizeWorker(db, args);
    } else if (command === 'stuck-processing') {
      listStuckProcessing(db, args);
    } else if (command === 'reset-processing') {
      resetProcessing(db, args);
    } else {
      usage(1);
    }
  } finally {
    closeMarketplaceHomepageDatabase(db);
  }
}

try {
  main();
} catch (error) {
  console.error(`troubleshoot_error ${error.message}`);
  process.exit(1);
}
