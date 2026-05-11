#!/usr/bin/env node

const path = require('path');

const {
  DEFAULT_DB_PATH,
  openMarketplaceHomepageDatabase,
  closeMarketplaceHomepageDatabase,
  listBacklogCandidates,
} = require('./marketplace-homepage-db');

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
    dbPath: DEFAULT_DB_PATH,
    statusFilter: 'all',
    sourceFilter: '',
    keywordFilter: '',
    backlogOrder: 'priority',
    seenTimeField: 'last_seen',
    seenAfter: '',
    seenBefore: '',
    limit: 20,
    json: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    switch (arg) {
      case '--db-path':
        options.dbPath = readFlagValue(argv, index, arg);
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
        options.seenAfter = readFlagValue(argv, index, arg);
        index += 1;
        break;
      case '--seen-before':
        options.seenBefore = readFlagValue(argv, index, arg);
        index += 1;
        break;
      case '--limit':
        options.limit = parseIntegerFlag(readFlagValue(argv, index, arg), arg, 1);
        index += 1;
        break;
      case '--json':
        options.json = true;
        break;
      default:
        throw new Error(`Unknown argument: ${arg}`);
    }
  }

  return options;
}

function listIndexes(db) {
  return db.prepare('PRAGMA index_list(homepage_listings)').all()
    .map((indexRow) => {
      const columns = db.prepare(`PRAGMA index_info(${JSON.stringify(indexRow.name)})`).all()
        .sort((a, b) => a.seqno - b.seqno)
        .map((column) => column.name);
      return {
        name: indexRow.name,
        unique: Boolean(indexRow.unique),
        origin: indexRow.origin,
        columns,
      };
    })
    .filter((indexRow) => indexRow.name.startsWith('idx_homepage_listings'));
}

function getCountsByStatus(db) {
  return db.prepare(`
    SELECT detail_status AS status, COUNT(*) AS count
    FROM homepage_listings
    GROUP BY detail_status
    ORDER BY count DESC, detail_status ASC
  `).all();
}

function printTextReport(payload) {
  process.stdout.write(`DB: ${payload.dbPath}\n`);
  process.stdout.write(`Organization: order=${payload.organization.backlogOrder} time=${payload.organization.seenTimeField}`);
  if (payload.organization.seenAfter) process.stdout.write(` after=${payload.organization.seenAfter}`);
  if (payload.organization.seenBefore) process.stdout.write(` before=${payload.organization.seenBefore}`);
  process.stdout.write('\n\n');

  process.stdout.write('Available homepage_listings indexes:\n');
  for (const indexRow of payload.indexes) {
    process.stdout.write(`- ${indexRow.name}: ${indexRow.columns.join(', ')}\n`);
  }

  process.stdout.write('\nCounts by status:\n');
  for (const row of payload.countsByStatus) {
    process.stdout.write(`- ${row.status}: ${row.count}\n`);
  }

  process.stdout.write('\nPreview candidates:\n');
  for (const row of payload.preview) {
    const title = row.detail_title || row.card_title || row.listing_id;
    process.stdout.write(`- ${row.listing_id} ${row.detail_status} rank=${row.last_seen_rank ?? ''} first=${row.first_seen_at} last=${row.last_seen_at} ${title}\n`);
  }
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  const { db, dbPath } = openMarketplaceHomepageDatabase(options.dbPath);

  try {
    const payload = {
      dbPath: path.isAbsolute(dbPath) ? dbPath : path.join(process.cwd(), dbPath),
      organization: {
        statusFilter: options.statusFilter,
        sourceFilter: options.sourceFilter,
        keywordFilter: options.keywordFilter,
        backlogOrder: options.backlogOrder,
        seenTimeField: options.seenTimeField,
        seenAfter: options.seenAfter,
        seenBefore: options.seenBefore,
        limit: options.limit,
      },
      indexes: listIndexes(db),
      countsByStatus: getCountsByStatus(db),
      preview: listBacklogCandidates(db, options),
    };

    if (options.json) {
      process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
    } else {
      printTextReport(payload);
    }
  } finally {
    closeMarketplaceHomepageDatabase(db);
  }
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}
