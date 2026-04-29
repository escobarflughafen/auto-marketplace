const fs = require('fs');
const path = require('path');

const {
  DEFAULT_DB_PATH,
  openMarketplaceHomepageDatabase,
  closeMarketplaceHomepageDatabase,
} = require('./marketplace-homepage-db');

const DEFAULT_OUTPUT_PATH = path.join(
  process.cwd(),
  'artifacts',
  'marketplace-homepage',
  'export.json',
);

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
    outputPath: DEFAULT_OUTPUT_PATH,
    pretty: true,
    stdout: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    switch (arg) {
      case '--db-path':
        options.dbPath = readFlagValue(argv, index, arg);
        index += 1;
        break;
      case '--output':
        options.outputPath = readFlagValue(argv, index, arg);
        index += 1;
        break;
      case '--stdout':
        options.stdout = true;
        break;
      case '--pretty':
        options.pretty = true;
        break;
      case '--compact':
        options.pretty = false;
        break;
      default:
        throw new Error(`Unknown argument: ${arg}`);
    }
  }

  options.outputPath = path.isAbsolute(options.outputPath)
    ? options.outputPath
    : path.join(process.cwd(), options.outputPath);

  return options;
}

function exportRows(db) {
  return db.prepare(`
    SELECT *
    FROM homepage_listings
    ORDER BY last_seen_at DESC, first_seen_at DESC
  `).all();
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const { db, dbPath } = openMarketplaceHomepageDatabase(options.dbPath);

  try {
    const rows = exportRows(db);
    const payload = {
      exportedAt: new Date().toISOString(),
      dbPath,
      rowCount: rows.length,
      rows,
    };
    const json = options.pretty
      ? JSON.stringify(payload, null, 2)
      : JSON.stringify(payload);

    if (options.stdout) {
      process.stdout.write(`${json}\n`);
      return;
    }

    await fs.promises.mkdir(path.dirname(options.outputPath), { recursive: true });
    await fs.promises.writeFile(options.outputPath, `${json}\n`, 'utf8');
    process.stdout.write(`Exported ${rows.length} rows to ${options.outputPath}\n`);
  } finally {
    closeMarketplaceHomepageDatabase(db);
  }
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`${message}\n`);
  process.exit(1);
});
