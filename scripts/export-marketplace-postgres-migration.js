#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const { once } = require('events');
const { DatabaseSync } = require('node:sqlite');

const DEFAULT_SQLITE_DB = path.join(process.cwd(), 'artifacts', 'marketplace-homepage', 'marketplace-homepage.db');

function usage() {
  process.stdout.write(`Usage:\n  node scripts/export-marketplace-postgres-migration.js [options]\n\nOptions:\n  --sqlite-db PATH       Source SQLite DB. Default: artifacts/marketplace-homepage/marketplace-homepage.db\n  --output-dir PATH      Output directory. Default: artifacts/postgres-migration/<timestamp>\n  --table NAME           Export one table. Repeatable. Defaults to every user table.\n  --schema-only          Emit schema SQL and manifest only.\n  --data-only            Emit data/load/verify artifacts only.\n  --drop-existing        Include DROP TABLE statements before CREATE TABLE.\n  --batch-size N         Rows read per SQLite page. Default: 5000.\n  --json                 Print JSON summary only.\n  -h, --help             Show this help.\n`);
}

function readArg(argv, index, flag) {
  const value = argv[index + 1];
  if (!value || value.startsWith('--')) throw new Error(`Missing value for ${flag}`);
  return value;
}

function parseArgs(argv) {
  const options = {
    sqliteDb: process.env.MARKETPLACE_SQLITE_DB || DEFAULT_SQLITE_DB,
    outputDir: '',
    tables: [],
    schemaOnly: false,
    dataOnly: false,
    dropExisting: false,
    batchSize: 5000,
    json: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    switch (arg) {
      case '--sqlite-db':
        options.sqliteDb = readArg(argv, index, arg);
        index += 1;
        break;
      case '--output-dir':
        options.outputDir = readArg(argv, index, arg);
        index += 1;
        break;
      case '--table':
        options.tables.push(readArg(argv, index, arg));
        index += 1;
        break;
      case '--schema-only':
        options.schemaOnly = true;
        break;
      case '--data-only':
        options.dataOnly = true;
        break;
      case '--drop-existing':
        options.dropExisting = true;
        break;
      case '--batch-size':
        options.batchSize = Number.parseInt(readArg(argv, index, arg), 10);
        index += 1;
        break;
      case '--json':
        options.json = true;
        break;
      case '-h':
      case '--help':
        usage();
        process.exit(0);
        break;
      default:
        throw new Error(`Unknown argument: ${arg}`);
    }
  }
  if (options.schemaOnly && options.dataOnly) throw new Error('--schema-only and --data-only are mutually exclusive.');
  if (!Number.isFinite(options.batchSize) || options.batchSize < 1) options.batchSize = 5000;
  options.batchSize = Math.min(Math.max(options.batchSize, 100), 50000);
  if (!options.outputDir) {
    const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
    options.outputDir = path.join(process.cwd(), 'artifacts', 'postgres-migration', stamp);
  }
  options.sqliteDb = path.resolve(options.sqliteDb);
  options.outputDir = path.resolve(options.outputDir);
  return options;
}

function quoteIdent(value) {
  return `"${String(value).replace(/"/g, '""')}"`;
}

function sqlLiteral(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

function mapSqliteType(type) {
  const normalized = String(type || '').toUpperCase();
  if (normalized.includes('INT')) return 'BIGINT';
  if (normalized.includes('REAL') || normalized.includes('FLOA') || normalized.includes('DOUB')) return 'DOUBLE PRECISION';
  if (normalized.includes('BLOB')) return 'BYTEA';
  return 'TEXT';
}

function sqliteColumnHasRealValues(db, table, column) {
  try {
    return Boolean(db.prepare(`
      SELECT 1 AS found
      FROM ${quoteIdent(table)}
      WHERE ${quoteIdent(column)} IS NOT NULL
        AND typeof(${quoteIdent(column)}) = 'real'
      LIMIT 1
    `).get());
  } catch {
    return false;
  }
}

function mapSqliteColumnType(db, table, column) {
  const normalized = String(column.type || '').toUpperCase();
  if (normalized.includes('INT') && sqliteColumnHasRealValues(db, table, column.name)) {
    return 'DOUBLE PRECISION';
  }
  return mapSqliteType(column.type);
}

function normalizeDefault(defaultValue) {
  if (defaultValue === null || defaultValue === undefined || defaultValue === '') return '';
  const raw = String(defaultValue).trim();
  if (!raw) return '';
  if (/^CURRENT_(DATE|TIME|TIMESTAMP)$/i.test(raw)) return ` DEFAULT ${raw.toUpperCase()}`;
  if (/^[-+]?\d+(\.\d+)?$/.test(raw)) return ` DEFAULT ${raw}`;
  if ((raw.startsWith("'") && raw.endsWith("'")) || (raw.startsWith('"') && raw.endsWith('"'))) {
    return ` DEFAULT ${raw}`;
  }
  return ` DEFAULT ${sqlLiteral(raw)}`;
}

function listUserTables(db, requestedTables = []) {
  const rows = db.prepare(`
    SELECT name
    FROM sqlite_master
    WHERE type = 'table'
      AND name NOT LIKE 'sqlite_%'
    ORDER BY name ASC
  `).all().map((row) => row.name);
  if (!requestedTables.length) return rows;
  const available = new Set(rows);
  for (const table of requestedTables) {
    if (!available.has(table)) throw new Error(`Unknown SQLite table: ${table}`);
  }
  return requestedTables;
}

function tableInfo(db, table) {
  return db.prepare(`PRAGMA table_info(${quoteIdent(table)})`).all();
}

function tableIndexes(db, table) {
  return db.prepare(`PRAGMA index_list(${quoteIdent(table)})`).all()
    .filter((row) => String(row.origin || '') !== 'pk')
    .map((row) => {
      const columns = db.prepare(`PRAGMA index_info(${quoteIdent(row.name)})`).all()
        .sort((left, right) => left.seqno - right.seqno)
        .map((column) => column.name)
        .filter(Boolean);
      return {
        name: row.name,
        unique: Number(row.unique) === 1,
        partial: Number(row.partial) === 1,
        columns,
      };
    })
    .filter((index) => index.columns.length > 0 && !index.partial);
}

function createTableSql(db, table, options = {}) {
  const columns = tableInfo(db, table);
  const pkColumns = columns.filter((column) => Number(column.pk) > 0)
    .sort((left, right) => Number(left.pk) - Number(right.pk));
  const inlineSinglePk = pkColumns.length === 1;
  const lines = columns.map((column) => {
    const parts = [quoteIdent(column.name), mapSqliteColumnType(db, table, column)];
    if (Number(column.notnull) === 1 || (inlineSinglePk && pkColumns[0].name === column.name)) parts.push('NOT NULL');
    if (inlineSinglePk && pkColumns[0].name === column.name) parts.push('PRIMARY KEY');
    const defaultSql = normalizeDefault(column.dflt_value);
    if (defaultSql) parts.push(defaultSql.trim());
    return `  ${parts.join(' ')}`;
  });
  if (pkColumns.length > 1) {
    lines.push(`  PRIMARY KEY (${pkColumns.map((column) => quoteIdent(column.name)).join(', ')})`);
  }
  const statements = [];
  if (options.dropExisting) statements.push(`DROP TABLE IF EXISTS ${quoteIdent(table)} CASCADE;`);
  statements.push(`CREATE TABLE IF NOT EXISTS ${quoteIdent(table)} (\n${lines.join(',\n')}\n);`);
  return statements.join('\n');
}

function createIndexSql(db, table) {
  return tableIndexes(db, table).map((index) => {
    const unique = index.unique ? 'UNIQUE ' : '';
    return `CREATE ${unique}INDEX IF NOT EXISTS ${quoteIdent(index.name)} ON ${quoteIdent(table)} (${index.columns.map((column) => quoteIdent(column)).join(', ')});`;
  }).join('\n');
}

function copyTextValue(value) {
  if (value === null || value === undefined) return '\\N';
  if (Buffer.isBuffer(value)) return `\\x${value.toString('hex')}`;
  return String(value)
    .replace(/\\/g, '\\\\')
    .replace(/\t/g, '\\t')
    .replace(/\n/g, '\\n')
    .replace(/\r/g, '\\r');
}

async function writeCopyLine(stream, line) {
  if (!stream.write(line)) {
    await once(stream, 'drain');
  }
}

async function finishWriteStream(stream) {
  stream.end();
  await Promise.race([
    once(stream, 'finish'),
    once(stream, 'error').then(([error]) => { throw error; }),
  ]);
}

async function exportTableData(db, table, outputFile, batchSize) {
  const columns = tableInfo(db, table).map((column) => column.name);
  const total = db.prepare(`SELECT COUNT(*) AS count FROM ${quoteIdent(table)}`).get().count;
  fs.mkdirSync(path.dirname(outputFile), { recursive: true });
  const stream = fs.createWriteStream(outputFile, { encoding: 'utf8' });
  const stmt = db.prepare(`SELECT ${columns.map((column) => quoteIdent(column)).join(', ')} FROM ${quoteIdent(table)} LIMIT ? OFFSET ?`);
  let written = 0;
  while (written < total) {
    const rows = stmt.all(batchSize, written);
    if (!rows.length) break;
    for (const row of rows) {
      await writeCopyLine(stream, `${columns.map((column) => copyTextValue(row[column])).join('\t')}\n`);
    }
    written += rows.length;
  }
  await finishWriteStream(stream);
  return { rowCount: total, writtenRows: written, columns };
}

function relativeUnixPath(fromDir, filePath) {
  return path.relative(fromDir, filePath).split(path.sep).join('/');
}

async function exportPostgresMigration(options) {
  if (!fs.existsSync(options.sqliteDb)) throw new Error(`SQLite DB not found: ${options.sqliteDb}`);
  fs.mkdirSync(options.outputDir, { recursive: true });
  const dataDir = path.join(options.outputDir, 'data');
  if (!options.schemaOnly) fs.mkdirSync(dataDir, { recursive: true });

  const db = new DatabaseSync(options.sqliteDb, { readOnly: true });
  try {
    const tables = listUserTables(db, options.tables);
    const manifest = {
      generatedAt: new Date().toISOString(),
      sqliteDb: options.sqliteDb,
      outputDir: options.outputDir,
      tables: [],
      schemaFile: path.join(options.outputDir, '001_schema.sql'),
      loadFile: path.join(options.outputDir, '002_load.sql'),
      verifyFile: path.join(options.outputDir, '003_verify.sql'),
    };

    if (!options.dataOnly) {
      const schemaSql = [
        '-- Generated by scripts/export-marketplace-postgres-migration.js',
        '-- Review before applying to production.',
        'SET client_min_messages TO warning;',
        ...tables.flatMap((table) => [
          '',
          `-- ${table}`,
          createTableSql(db, table, { dropExisting: options.dropExisting }),
          createIndexSql(db, table),
        ]),
        '',
      ].join('\n');
      fs.writeFileSync(manifest.schemaFile, schemaSql);
    }

    const loadLines = [
      '\\set ON_ERROR_STOP on',
      'BEGIN;',
    ];
    const verifyLines = [
      '\\set ON_ERROR_STOP on',
      'WITH expected(table_name, expected_count) AS (',
      'VALUES',
    ];
    const expectedRows = [];

    for (const table of tables) {
      const columns = tableInfo(db, table).map((column) => column.name);
      const tableManifest = {
        name: table,
        columns,
        rowCount: 0,
        dataFile: options.schemaOnly ? '' : path.join(dataDir, `${table}.tsv`),
      };
      if (!options.schemaOnly) {
        const exported = await exportTableData(db, table, tableManifest.dataFile, options.batchSize);
        tableManifest.rowCount = exported.rowCount;
        tableManifest.writtenRows = exported.writtenRows;
        const dataFileForPsql = path.join(':DATA_DIR', relativeUnixPath(dataDir, tableManifest.dataFile)).split(path.sep).join('/');
        loadLines.push(`\\copy ${quoteIdent(table)} (${columns.map((column) => quoteIdent(column)).join(', ')}) FROM '${dataFileForPsql}' WITH (FORMAT text, DELIMITER E'\\t', NULL '\\N')`);
      } else {
        tableManifest.rowCount = db.prepare(`SELECT COUNT(*) AS count FROM ${quoteIdent(table)}`).get().count;
      }
      expectedRows.push(`  (${sqlLiteral(table)}, ${tableManifest.rowCount})`);
      manifest.tables.push(tableManifest);
    }

    if (!options.schemaOnly) {
      loadLines.push('COMMIT;', 'ANALYZE;', '');
      fs.writeFileSync(manifest.loadFile, loadLines.join('\n'));
    }

    verifyLines.push(expectedRows.join(',\n'));
    verifyLines.push(')');
    verifyLines.push("SELECT expected.table_name, expected.expected_count, actual.actual_count, CASE WHEN expected.expected_count = actual.actual_count THEN 'ok' ELSE 'mismatch' END AS status");
    verifyLines.push('FROM expected');
    verifyLines.push('CROSS JOIN LATERAL (');
    verifyLines.push("  SELECT CASE expected.table_name");
    for (const table of tables) {
      verifyLines.push(`    WHEN ${sqlLiteral(table)} THEN (SELECT COUNT(*) FROM ${quoteIdent(table)})`);
    }
    verifyLines.push('  END AS actual_count');
    verifyLines.push(') actual');
    verifyLines.push('ORDER BY expected.table_name;');
    verifyLines.push('');
    fs.writeFileSync(manifest.verifyFile, verifyLines.join('\n'));

    fs.writeFileSync(path.join(options.outputDir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
    fs.writeFileSync(path.join(options.outputDir, 'README.md'), [
      '# PostgreSQL Migration Artifact',
      '',
      'Generated from a SQLite marketplace DB.',
      '',
      'Load order:',
      '',
      '1. Review and apply `001_schema.sql` to the target PostgreSQL database.',
      '2. Load data with `002_load.sql`, replacing `:DATA_DIR` with the absolute artifact data directory path.',
      '3. Run `003_verify.sql` and compare every row count with `manifest.json`.',
      '',
      'Example:',
      '',
      '```bash',
      `psql "$MARKETPLACE_DATABASE_URL" -f ${path.join(options.outputDir, '001_schema.sql')}`,
      `sed "s#:DATA_DIR#${dataDir.replace(/#/g, '\\#')}#g" ${path.join(options.outputDir, '002_load.sql')} | psql "$MARKETPLACE_DATABASE_URL"`,
      `psql "$MARKETPLACE_DATABASE_URL" -f ${path.join(options.outputDir, '003_verify.sql')}`,
      '```',
      '',
    ].join('\n'));
    return manifest;
  } finally {
    db.close();
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const manifest = await exportPostgresMigration(options);
  if (options.json) {
    process.stdout.write(`${JSON.stringify({ outputDir: manifest.outputDir, tableCount: manifest.tables.length, rowCount: manifest.tables.reduce((sum, table) => sum + table.rowCount, 0) }, null, 2)}\n`);
  } else {
    process.stdout.write(`postgres_migration_exported output_dir=${manifest.outputDir} tables=${manifest.tables.length} rows=${manifest.tables.reduce((sum, table) => sum + table.rowCount, 0)}\n`);
  }
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error.stack || error.message || error);
    process.exit(1);
  });
}

module.exports = {
  parseArgs,
  exportPostgresMigration,
  quoteIdent,
  copyTextValue,
  mapSqliteType,
};
