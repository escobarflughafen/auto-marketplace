#!/usr/bin/env node
const fs = require('fs');
const path = require('path');

const DEFAULT_DB_MODULE = path.join(process.cwd(), 'scripts', 'marketplace-homepage-db.js');

const COVERED_POSTGRES_EXPORTS = new Set([
  'DEFAULT_DB_PATH',
  'resolveDbPath',
  'extractListingId',
  'canonicalizeListingUrl',
  'normalizeKeyword',
  'hashContent',
  'listWorkerParameterProfiles',
  'getWorkerParameterProfile',
  'upsertWorkerParameterProfile',
  'deleteWorkerParameterProfile',
  'listSummaryQueryCards',
  'getSummaryQueryCard',
  'upsertSummaryQueryCard',
  'deleteSummaryQueryCard',
  'listSavedQueries',
  'getSavedQuery',
  'upsertSavedQuery',
  'setSavedQueryOverview',
  'deleteSavedQuery',
  'insertWorkflowRun',
  'updateWorkflowRun',
  'getWorkflowRun',
  'getWorkflowRunLive',
  'listWorkflowRuns',
  'appendListingEvent',
  'getListingEvent',
  'getListingEvents',
  'getLatestListingEvent',
  'listWorkerListingEvents',
  'getWorkerListingEventStats',
  'listWorkerAuditEvents',
  'getWorkerAuditEventStats',
  'appendWorkflowEvent',
  'getWorkflowEvent',
  'listWorkflowEvents',
  'listWorkerWorkflowEvents',
]);

const READ_NAME_PATTERNS = [
  /^get[A-Z]/,
  /^list[A-Z]/,
  /^count[A-Z]/,
  /^scan[A-Z]/,
  /^pick[A-Z]/,
  /^read[A-Z]/,
];

const WRITE_NAME_PATTERNS = [
  /^upsert[A-Z]/,
  /^claim[A-Z]/,
  /^create[A-Z]/,
  /^delete[A-Z]/,
  /^mark[A-Z]/,
  /^release[A-Z]/,
  /^recover[A-Z]/,
  /^append[A-Z]/,
  /^add[A-Z]/,
  /^clear[A-Z]/,
  /^refresh[A-Z]/,
  /^update[A-Z]/,
  /^set[A-Z]/,
  /^merge[A-Z]/,
  /^insert[A-Z]/,
  /^run[A-Z]/,
];

const KNOWN_RUNTIME_BOUNDARIES = new Map([
  ['openMarketplaceHomepageDatabase', 'runtime'],
  ['closeMarketplaceHomepageDatabase', 'runtime'],
  ['runTransaction', 'transaction'],
  ['getDatabaseMaintenanceReport', 'maintenance'],
  ['runDatabaseMaintenance', 'maintenance'],
]);

function usage() {
  process.stdout.write(`Usage:\n  node scripts/postgres-cutover-inventory.js [options]\n\nOptions:\n  --db-module PATH       DB helper module. Default: scripts/marketplace-homepage-db.js\n  --json                 Print JSON report.\n  --strict               Exit nonzero while required PostgreSQL coverage is incomplete.\n  -h, --help             Show this help.\n`);
}

function parseArgs(argv) {
  const options = {
    dbModule: DEFAULT_DB_MODULE,
    json: false,
    strict: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    switch (arg) {
      case '--db-module':
        options.dbModule = argv[++index] || '';
        break;
      case '--json':
        options.json = true;
        break;
      case '--strict':
        options.strict = true;
        break;
      case '-h':
      case '--help':
        options.help = true;
        break;
      default:
        throw new Error(`Unknown option: ${arg}`);
    }
  }
  return options;
}

function extractModuleExports(sourceText) {
  const match = sourceText.match(/module\.exports\s*=\s*\{([\s\S]*?)\n\};/);
  if (!match) throw new Error('Could not find module.exports object.');
  return match[1]
    .split(/\r?\n/)
    .map((line) => line.replace(/\/\/.*$/, '').trim())
    .map((line) => line.replace(/,$/, '').trim())
    .filter(Boolean)
    .map((line) => line.split(':')[0].trim())
    .filter((name) => /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(name));
}

function classifyExport(name) {
  if (KNOWN_RUNTIME_BOUNDARIES.has(name)) return KNOWN_RUNTIME_BOUNDARIES.get(name);
  if (WRITE_NAME_PATTERNS.some((pattern) => pattern.test(name))) return 'write';
  if (READ_NAME_PATTERNS.some((pattern) => pattern.test(name))) return 'read';
  if (/^(DEFAULT_|resolve|extract|canonicalize|normalize|hash)/.test(name)) return 'pure';
  return 'unknown';
}

function isRequiredForCutover(kind) {
  return ['read', 'write', 'transaction', 'maintenance', 'runtime', 'unknown'].includes(kind);
}

function buildInventory(options = {}) {
  const dbModule = path.isAbsolute(options.dbModule || DEFAULT_DB_MODULE)
    ? options.dbModule || DEFAULT_DB_MODULE
    : path.join(process.cwd(), options.dbModule || DEFAULT_DB_MODULE);
  const sourceText = fs.readFileSync(dbModule, 'utf8');
  const exports = extractModuleExports(sourceText);
  const rows = exports.map((name) => {
    const kind = classifyExport(name);
    const covered = COVERED_POSTGRES_EXPORTS.has(name);
    const requiredForCutover = isRequiredForCutover(kind);
    return {
      name,
      kind,
      requiredForCutover,
      postgresCovered: covered,
      gap: requiredForCutover && !covered,
    };
  });
  const counts = rows.reduce((accumulator, row) => {
    accumulator.total += 1;
    accumulator.byKind[row.kind] = (accumulator.byKind[row.kind] || 0) + 1;
    if (row.requiredForCutover) accumulator.required += 1;
    if (row.postgresCovered) accumulator.covered += 1;
    if (row.gap) accumulator.gaps += 1;
    return accumulator;
  }, { total: 0, required: 0, covered: 0, gaps: 0, byKind: {} });
  return {
    ok: counts.gaps === 0,
    generatedAt: new Date().toISOString(),
    dbModule,
    counts,
    exports: rows,
    nextRequiredGaps: rows.filter((row) => row.gap).map((row) => row.name),
  };
}

function printTextReport(report) {
  process.stdout.write(`postgres_cutover_inventory ok=${report.ok} exports=${report.counts.total} required=${report.counts.required} gaps=${report.counts.gaps}\n`);
  for (const [kind, count] of Object.entries(report.counts.byKind).sort()) {
    process.stdout.write(`- ${kind}: ${count}\n`);
  }
  if (report.nextRequiredGaps.length) {
    process.stdout.write('required_gaps:\n');
    for (const name of report.nextRequiredGaps) {
      const row = report.exports.find((item) => item.name === name);
      process.stdout.write(`- ${name} (${row?.kind || 'unknown'})\n`);
    }
  }
}

function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  if (options.help) {
    usage();
    return 0;
  }
  const report = buildInventory(options);
  if (options.json) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } else {
    printTextReport(report);
  }
  return options.strict && !report.ok ? 1 : 0;
}

if (require.main === module) {
  process.stdout.on('error', (error) => {
    if (error.code === 'EPIPE') process.exit(0);
    throw error;
  });
  try {
    process.exitCode = main();
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}

module.exports = {
  COVERED_POSTGRES_EXPORTS,
  parseArgs,
  extractModuleExports,
  classifyExport,
  buildInventory,
};
