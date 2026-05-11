const {
  DEFAULT_DB_PATH,
  openMarketplaceHomepageDatabase,
  closeMarketplaceHomepageDatabase,
  getDatabaseMaintenanceReport,
  runDatabaseMaintenance,
} = require('./marketplace-homepage-db');

function readFlagValue(argv, index, flagName) {
  const value = argv[index + 1];
  if (!value || value.startsWith('--')) {
    throw new Error(`Missing value for ${flagName}`);
  }
  return value;
}

function parseArgs(argv) {
  const options = {
    dbPath: DEFAULT_DB_PATH,
    checkpoint: true,
    optimize: true,
    analyze: false,
    vacuum: false,
    dryRun: false,
    json: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    switch (arg) {
      case '--db-path':
        options.dbPath = readFlagValue(argv, index, arg);
        index += 1;
        break;
      case '--checkpoint':
        options.checkpoint = true;
        break;
      case '--no-checkpoint':
        options.checkpoint = false;
        break;
      case '--optimize':
        options.optimize = true;
        break;
      case '--no-optimize':
        options.optimize = false;
        break;
      case '--analyze':
        options.analyze = true;
        break;
      case '--vacuum':
        options.vacuum = true;
        break;
      case '--dry-run':
        options.dryRun = true;
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

function formatBytes(value) {
  const bytes = Number(value) || 0;
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(1)} GB`;
}

function renderReport(payload) {
  const report = payload.after || payload;
  const before = payload.before || null;
  const lines = [
    `DB: ${report.dbPath}`,
    `Journal: ${report.journalMode}`,
    `Rows: listings=${report.rows.homepageListings} events=${report.rows.listingEvents} workflows=${report.rows.workflowRuns}`,
    `Files: db=${formatBytes(report.files.dbBytes)} wal=${formatBytes(report.files.walBytes)} shm=${formatBytes(report.files.shmBytes)}`,
    `Pages: count=${report.pageCount} size=${report.pageSize} freelist=${report.freelistCount}`,
  ];
  if (before) {
    lines.push(`Before WAL: ${formatBytes(before.files.walBytes)}`);
    lines.push(`Actions: ${payload.actions.map((action) => typeof action === 'string' ? action : Object.keys(action)[0]).join(', ') || 'none'}`);
  }
  return lines.join('\n');
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  const { db, dbPath } = openMarketplaceHomepageDatabase(options.dbPath);
  try {
    const payload = options.dryRun
      ? getDatabaseMaintenanceReport(db, dbPath)
      : runDatabaseMaintenance(db, dbPath, options);
    if (options.json) {
      console.log(JSON.stringify(payload, null, 2));
    } else {
      console.log(renderReport(payload));
    }
  } finally {
    closeMarketplaceHomepageDatabase(db);
  }
}

if (require.main === module) {
  main();
}

module.exports = {
  parseArgs,
  renderReport,
};
