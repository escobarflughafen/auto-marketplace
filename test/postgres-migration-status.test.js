const fs = require('fs');
const os = require('os');
const path = require('path');
const test = require('node:test');
const assert = require('node:assert/strict');

const {
  parseArgs,
  readEnvFile,
  latestMigrationName,
  verifyOutputStatus,
  shadowCompareStatus,
  buildStatusReport,
} = require('../scripts/postgres-migration-status');

function createProject() {
  const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'postgres-migration-status-'));
  fs.mkdirSync(path.join(projectDir, 'ops'), { recursive: true });
  fs.mkdirSync(path.join(projectDir, 'scripts'), { recursive: true });
  fs.mkdirSync(path.join(projectDir, 'artifacts', 'postgres-migration', 'prod-old'), { recursive: true });
  const migrationDir = path.join(projectDir, 'artifacts', 'postgres-migration', 'prod-new');
  fs.mkdirSync(migrationDir, { recursive: true });
  for (const file of ['docker-compose.postgres.yml', '.postgres-migration.env']) fs.writeFileSync(path.join(projectDir, file), '');
  fs.writeFileSync(path.join(projectDir, '.postgres-migration.env'), [
    'MARKETPLACE_POSTGRES_DB=marketplace',
    'MARKETPLACE_POSTGRES_USER=marketplace',
    'MARKETPLACE_POSTGRES_CONTAINER=marketplace-postgres',
    'MARKETPLACE_POSTGRES_PASSWORD=secret-value',
  ].join('\n'));
  fs.writeFileSync(path.join(projectDir, 'ops', 'postgres-prod-shadow-migration.sh'), '#!/usr/bin/env bash\n');
  fs.writeFileSync(path.join(projectDir, 'scripts', 'export-marketplace-postgres-migration.js'), '');
  fs.writeFileSync(path.join(projectDir, 'scripts', 'compare-marketplace-postgres-shadow.js'), '');
  fs.writeFileSync(path.join(migrationDir, '001_schema.sql'), '-- schema');
  fs.writeFileSync(path.join(migrationDir, '002_load.sql'), '-- load');
  fs.writeFileSync(path.join(migrationDir, '003_verify.sql'), '-- verify');
  fs.writeFileSync(path.join(migrationDir, 'verify-output.txt'), 'table_name | expected_count | actual_count | status\nhomepage_listings | 2 | 2 | ok\n');
  fs.writeFileSync(path.join(migrationDir, 'shadow-compare.json'), JSON.stringify({ ok: true, probeCount: 2, failed: 0 }));
  fs.writeFileSync(path.join(migrationDir, 'manifest.json'), JSON.stringify({ tables: [{ name: 'homepage_listings', rowCount: 2 }] }));
  fs.utimesSync(path.join(projectDir, 'artifacts', 'postgres-migration', 'prod-old'), new Date(Date.now() - 10000), new Date(Date.now() - 10000));
  fs.utimesSync(migrationDir, new Date(), new Date());
  return { projectDir, migrationDir };
}

function createDockerRunner({ running = true, ready = true, tableCount = 3 } = {}) {
  return (cmd, args) => {
    assert.equal(cmd, 'docker');
    if (args[0] === 'inspect') {
      return {
        status: running ? 0 : 1,
        stdout: running ? 'true healthy\n' : '',
        stderr: running ? '' : 'not found',
      };
    }
    if (args.includes('pg_isready')) {
      return {
        status: ready ? 0 : 1,
        stdout: ready ? 'accepting connections\n' : '',
        stderr: ready ? '' : 'rejecting connections',
      };
    }
    if (args.includes('psql')) {
      return {
        status: 0,
        stdout: `${tableCount}\n`,
        stderr: '',
      };
    }
    return { status: 1, stdout: '', stderr: `unexpected docker args: ${args.join(' ')}` };
  };
}

test('parseArgs reads status options', () => {
  assert.deepEqual(parseArgs(['--project-dir', '/srv/app', '--migration-name', 'prod-a', '--json', '--strict']), {
    projectDir: '/srv/app',
    envFile: '.postgres-migration.env',
    migrationName: 'prod-a',
    postgresContainer: '',
    json: true,
    strict: true,
  });
});

test('readEnvFile parses simple env files without exposing secrets in status report', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'postgres-env-'));
  const envPath = path.join(tempDir, '.env');
  fs.writeFileSync(envPath, 'MARKETPLACE_POSTGRES_USER=marketplace\nMARKETPLACE_POSTGRES_PASSWORD=secret\nQUOTED="value"\n');
  assert.deepEqual(readEnvFile(envPath), {
    MARKETPLACE_POSTGRES_USER: 'marketplace',
    MARKETPLACE_POSTGRES_PASSWORD: 'secret',
    QUOTED: 'value',
  });
});

test('artifact status helpers detect verification and read-compare readiness', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'postgres-status-files-'));
  const okVerify = path.join(tempDir, 'verify-output.txt');
  const badVerify = path.join(tempDir, 'bad-verify-output.txt');
  const compare = path.join(tempDir, 'shadow-compare.json');
  fs.writeFileSync(okVerify, 'homepage_listings ok\n');
  fs.writeFileSync(badVerify, 'homepage_listings mismatch\n');
  fs.writeFileSync(compare, JSON.stringify({ ok: true, probeCount: 4, failed: 0 }));

  assert.equal(verifyOutputStatus(okVerify).ok, true);
  assert.equal(verifyOutputStatus(badVerify).ok, false);
  assert.equal(shadowCompareStatus(compare).ok, true);
  assert.equal(shadowCompareStatus(path.join(tempDir, 'missing.json')).ok, false);
});

test('buildStatusReport summarizes a ready shadow migration without leaking password', () => {
  const { projectDir } = createProject();
  const report = buildStatusReport({ projectDir }, createDockerRunner());

  assert.equal(report.ok, true);
  assert.equal(report.migration.name, 'prod-new');
  assert.equal(report.postgres.container, 'marketplace-postgres');
  assert.equal(report.postgres.ready, true);
  assert.equal(report.postgres.tableCount, 3);
  assert.equal(report.migration.manifestRows, 2);
  assert.ok(report.checks.every((item) => item.ok));
  assert.doesNotMatch(JSON.stringify(report), /secret-value/);
});

test('buildStatusReport reports failed readiness gates in strict-readable checks', () => {
  const { projectDir } = createProject();
  fs.writeFileSync(path.join(projectDir, 'artifacts', 'postgres-migration', 'prod-new', 'shadow-compare.json'), JSON.stringify({ ok: false, probeCount: 2, failed: 1 }));
  const report = buildStatusReport({ projectDir }, createDockerRunner({ ready: false, tableCount: 0 }));
  const failed = report.checks.filter((item) => !item.ok).map((item) => item.name);

  assert.equal(report.ok, false);
  assert.ok(failed.includes('postgres_ready'));
  assert.ok(failed.includes('shadow_compare'));
  assert.ok(failed.includes('postgres_loaded_tables'));
});

test('latestMigrationName returns empty when no migration directory exists', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'postgres-status-empty-'));
  assert.equal(latestMigrationName(path.join(tempDir, 'missing')), '');
});
