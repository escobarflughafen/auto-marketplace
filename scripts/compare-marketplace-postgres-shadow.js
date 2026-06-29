#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const DEFAULT_DB_PATH = path.join(
  process.cwd(),
  'artifacts',
  'marketplace-homepage',
  'marketplace-homepage.db',
);
const sqliteQueries = require('./marketplace-homepage-query');
const postgresQueries = require('./marketplace-homepage-query-postgres');

const DEFAULT_PROBES = [
  { name: 'recent-default', query: '', limit: 10, offset: 0, sort: 'recent' },
  { name: 'pending-status', query: 'status:pending', limit: 10, offset: 0, sort: 'recent' },
  { name: 'legacy-title-price', query: 'title contains "leica" and price >= 500', limit: 10, offset: 0, sort: 'price', sortDirection: 'desc' },
  { name: 'lite-kql-price', query: 'listings | where title contains "pentax" and price >= 1000 | sort by price desc | take 10', limit: 10, offset: 0 },
];

function usage() {
  process.stdout.write(`Usage:\n  node scripts/compare-marketplace-postgres-shadow.js [options]\n\nOptions:\n  --sqlite-db PATH        SQLite DB path. Default: artifacts/marketplace-homepage/marketplace-homepage.db\n  --postgres-url URL      PostgreSQL URL. Default: MARKETPLACE_POSTGRES_URL or DATABASE_URL\n  --query QUERY           Add a query probe. Repeatable. Defaults to representative probes.\n  --limit N               Limit for --query probes. Default: 10\n  --output PATH           Write JSON report to a file.\n  --json                  Print JSON report instead of text summary.\n  --fail-fast             Stop after the first mismatch/error.\n  -h, --help              Show this help.\n`);
}

function parseArgs(argv) {
  const options = {
    sqliteDb: DEFAULT_DB_PATH,
    postgresUrl: process.env.MARKETPLACE_POSTGRES_URL || process.env.DATABASE_URL || '',
    queries: [],
    limit: 10,
    output: '',
    json: false,
    failFast: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    switch (arg) {
      case '--sqlite-db':
        options.sqliteDb = argv[++index] || '';
        break;
      case '--postgres-url':
        options.postgresUrl = argv[++index] || '';
        break;
      case '--query':
        options.queries.push(argv[++index] || '');
        break;
      case '--limit':
        options.limit = Number.parseInt(argv[++index], 10) || 10;
        break;
      case '--output':
        options.output = argv[++index] || '';
        break;
      case '--json':
        options.json = true;
        break;
      case '--fail-fast':
        options.failFast = true;
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

function resolveDbPath(dbPath) {
  return path.isAbsolute(dbPath) ? dbPath : path.join(process.cwd(), dbPath);
}

function postgresLiteral(value) {
  if (value === null || value === undefined) return 'NULL';
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error(`Cannot encode non-finite PostgreSQL number: ${value}`);
    return String(value);
  }
  if (typeof value === 'bigint') return String(value);
  if (typeof value === 'boolean') return value ? 'TRUE' : 'FALSE';
  return `'${String(value).replace(/'/g, "''")}'`;
}

function inlinePostgresParams(sql, params = []) {
  return String(sql || '').replace(/\$(\d+)\b/g, (_match, rawIndex) => {
    const index = Number.parseInt(rawIndex, 10) - 1;
    if (index < 0 || index >= params.length) {
      throw new Error(`Missing PostgreSQL parameter $${rawIndex}`);
    }
    return postgresLiteral(params[index]);
  });
}

function wrapRowsJsonSql(sql) {
  return `SELECT COALESCE(json_agg(row_to_json(_shadow_rows)), '[]'::json) AS rows FROM (${sql}) _shadow_rows`;
}

function runPsqlJson(postgresUrl, sql, runner = spawnSync) {
  const result = runner('psql', [
    postgresUrl,
    '-X',
    '-A',
    '-t',
    '-q',
    '-v',
    'ON_ERROR_STOP=1',
    '-c',
    sql,
  ], {
    encoding: 'utf8',
    maxBuffer: 1024 * 1024 * 64,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    const error = new Error(`psql failed with status ${result.status}: ${String(result.stderr || '').trim()}`);
    error.status = result.status;
    throw error;
  }
  const text = String(result.stdout || '').trim();
  return text ? JSON.parse(text) : [];
}

function normalizeScalar(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'bigint') return Number(value);
  const text = String(value);
  if (/^-?\d+(?:\.\d+)?$/.test(text)) return Number(text);
  return text;
}

function normalizeRows(rows) {
  return (rows || []).map((row) => Object.fromEntries(
    Object.entries(row || {}).map(([key, value]) => [key, normalizeScalar(value)]),
  ));
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function diffValues(expected, actual) {
  const expectedJson = stableJson(expected);
  const actualJson = stableJson(actual);
  if (expectedJson === actualJson) return null;
  return { expected, actual };
}

function sqliteAll(db, spec) {
  return normalizeRows(db.prepare(spec.sql).all(...(spec.params || [])));
}

function sqliteGet(db, spec) {
  return normalizeRows([db.prepare(spec.sql).get(...(spec.params || [])) || {}])[0];
}

function postgresAll(postgresUrl, spec, runner) {
  const sql = wrapRowsJsonSql(inlinePostgresParams(spec.sql, spec.params));
  return normalizeRows(runPsqlJson(postgresUrl, sql, runner));
}

function postgresGet(postgresUrl, spec, runner) {
  const rows = postgresAll(postgresUrl, spec, runner);
  return rows[0] || {};
}

function buildProbeFromQuery(query, options = {}) {
  return {
    name: `query:${query || '<empty>'}`,
    query,
    limit: Math.max(1, Math.min(Number.parseInt(options.limit, 10) || 10, 100)),
    offset: 0,
    sort: options.sort || '',
    sortDirection: options.sortDirection || '',
  };
}

function probesForOptions(options) {
  if (options.queries.length) {
    return options.queries.map((query) => buildProbeFromQuery(query, options));
  }
  return DEFAULT_PROBES;
}

function compareProbe(db, postgresUrl, probe, runner) {
  const listingOptions = {
    query: probe.query,
    limit: probe.limit,
    offset: probe.offset,
    sort: probe.sort,
    sortDirection: probe.sortDirection,
  };
  const sqliteListingQuery = sqliteQueries.buildListingsQuery(listingOptions);
  const postgresListingQuery = postgresQueries.buildListingsQuery(listingOptions);
  const sqliteCountQuery = sqliteQueries.buildCountQuery({ query: probe.query });
  const postgresCountQuery = postgresQueries.buildCountQuery({ query: probe.query });
  const sqliteStatsQueries = sqliteQueries.buildListingsStatsQueries({ query: probe.query });
  const postgresStatsQueries = postgresQueries.buildListingsStatsQueries({ query: probe.query });

  const sqliteRows = sqliteAll(db, sqliteListingQuery);
  const postgresRows = postgresAll(postgresUrl, postgresListingQuery, runner);
  const sqliteIds = sqliteRows.map((row) => row.listing_id);
  const postgresIds = postgresRows.map((row) => row.listing_id);
  const sqliteCount = sqliteGet(db, sqliteCountQuery);
  const postgresCount = postgresGet(postgresUrl, postgresCountQuery, runner);
  const sqliteSummary = sqliteGet(db, sqliteStatsQueries.priceSummary);
  const postgresSummary = postgresGet(postgresUrl, postgresStatsQueries.priceSummary, runner);

  const checks = [
    { name: 'listing_ids', diff: diffValues(sqliteIds, postgresIds) },
    { name: 'count', diff: diffValues(sqliteCount, postgresCount) },
    { name: 'price_summary', diff: diffValues(sqliteSummary, postgresSummary) },
  ];
  const mismatches = checks.filter((check) => check.diff);
  return {
    name: probe.name,
    query: probe.query,
    limit: probe.limit,
    offset: probe.offset,
    ok: mismatches.length === 0,
    checks: checks.map((check) => ({ name: check.name, ok: !check.diff, ...(check.diff ? { diff: check.diff } : {}) })),
  };
}

function compareShadow(options, runner = spawnSync) {
  const sqliteDb = resolveDbPath(options.sqliteDb || DEFAULT_DB_PATH);
  if (!options.postgresUrl) throw new Error('Missing --postgres-url or MARKETPLACE_POSTGRES_URL.');
  if (!fs.existsSync(sqliteDb)) throw new Error(`SQLite DB not found: ${sqliteDb}`);
  const { DatabaseSync } = require('node:sqlite');
  const db = new DatabaseSync(sqliteDb, { readOnly: true });
  const startedAt = new Date().toISOString();
  const probes = [];
  try {
    for (const probe of probesForOptions(options)) {
      try {
        probes.push(compareProbe(db, options.postgresUrl, probe, runner));
      } catch (error) {
        probes.push({ name: probe.name, query: probe.query, ok: false, error: error.message });
        if (options.failFast) break;
      }
      if (options.failFast && probes.at(-1)?.ok === false) break;
    }
  } finally {
    db.close();
  }
  const failed = probes.filter((probe) => !probe.ok).length;
  return {
    ok: failed === 0,
    startedAt,
    sqliteDb,
    probeCount: probes.length,
    failed,
    probes,
  };
}

function printTextReport(report) {
  process.stdout.write(`postgres_shadow_compare ok=${report.ok} probes=${report.probeCount} failed=${report.failed}\n`);
  for (const probe of report.probes) {
    process.stdout.write(`- ${probe.ok ? 'ok' : 'FAIL'} ${probe.name}\n`);
    if (probe.error) process.stdout.write(`  error: ${probe.error}\n`);
    for (const check of probe.checks || []) {
      process.stdout.write(`  ${check.ok ? 'ok' : 'FAIL'} ${check.name}\n`);
    }
  }
}

function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  if (options.help) {
    usage();
    return 0;
  }
  const report = compareShadow(options);
  if (options.output) fs.writeFileSync(options.output, `${JSON.stringify(report, null, 2)}\n`);
  if (options.json) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } else {
    printTextReport(report);
  }
  return report.ok ? 0 : 1;
}

if (require.main === module) {
  try {
    process.exitCode = main();
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}

module.exports = {
  DEFAULT_PROBES,
  parseArgs,
  postgresLiteral,
  inlinePostgresParams,
  wrapRowsJsonSql,
  normalizeRows,
  diffValues,
  compareProbe,
  compareShadow,
};
