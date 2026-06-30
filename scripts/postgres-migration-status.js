#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

function usage() {
  process.stdout.write(`Usage:\n  node scripts/postgres-migration-status.js [options]\n\nOptions:\n  --project-dir DIR          Project dir. Default: current directory.\n  --env-file FILE            PostgreSQL env file. Default: .postgres-migration.env\n  --migration-name NAME      Artifact directory under artifacts/postgres-migration. Default: latest.\n  --postgres-container NAME  PostgreSQL container override.\n  --app-container NAME       App container to audit. Default: auto-browser.\n  --json                     Print JSON report.\n  --strict                   Exit nonzero unless all readiness checks pass.\n  -h, --help                 Show this help.\n`);
}

function parseArgs(argv) {
  const options = {
    projectDir: process.cwd(),
    envFile: '.postgres-migration.env',
    migrationName: '',
    postgresContainer: '',
    appContainer: 'auto-browser',
    json: false,
    strict: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    switch (arg) {
      case '--project-dir':
        options.projectDir = argv[++index] || '';
        break;
      case '--env-file':
        options.envFile = argv[++index] || '';
        break;
      case '--migration-name':
        options.migrationName = argv[++index] || '';
        break;
      case '--postgres-container':
        options.postgresContainer = argv[++index] || '';
        break;
      case '--app-container':
        options.appContainer = argv[++index] || '';
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

function readEnvFile(filePath) {
  if (!fs.existsSync(filePath)) return {};
  const env = {};
  for (const line of fs.readFileSync(filePath, 'utf8').split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const match = trimmed.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (!match) continue;
    let value = match[2];
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    env[match[1]] = value;
  }
  return env;
}

function check(name, ok, details = {}) {
  return { ...details, name, ok: Boolean(ok) };
}

function latestMigrationName(root) {
  if (!fs.existsSync(root)) return '';
  const entries = fs.readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => {
      const fullPath = path.join(root, entry.name);
      return { name: entry.name, mtimeMs: fs.statSync(fullPath).mtimeMs };
    })
    .sort((left, right) => right.mtimeMs - left.mtimeMs);
  return entries[0]?.name || '';
}

function readJsonFile(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (error) {
    return { error: error.message };
  }
}

function runDocker(args, runner = spawnSync) {
  const result = runner('docker', args, { encoding: 'utf8', maxBuffer: 1024 * 1024 * 16 });
  if (result.error) return { ok: false, error: result.error.message, stdout: '', stderr: '' };
  return {
    ok: result.status === 0,
    status: result.status,
    stdout: String(result.stdout || '').trim(),
    stderr: String(result.stderr || '').trim(),
  };
}

function inspectContainer(containerName, runner = spawnSync) {
  if (!containerName) return { exists: false, running: false, health: '', error: 'missing container name' };
  const result = runDocker(['inspect', '--format', '{{.State.Running}} {{if .State.Health}}{{.State.Health.Status}}{{end}}', containerName], runner);
  if (!result.ok) return { exists: false, running: false, health: '', error: result.stderr || result.error || 'docker inspect failed' };
  const [running, health = ''] = result.stdout.split(/\s+/);
  return { exists: true, running: running === 'true', health };
}

function pgIsReady(containerName, user, database, runner = spawnSync) {
  if (!containerName) return { ok: false, error: 'missing container name' };
  const result = runDocker(['exec', containerName, 'pg_isready', '-U', user, '-d', database], runner);
  return { ok: result.ok, output: result.stdout || result.stderr || result.error || '' };
}

function postgresTableCount(containerName, user, database, runner = spawnSync) {
  if (!containerName) return { ok: false, count: null, error: 'missing container name' };
  const sql = "SELECT COUNT(*) FROM information_schema.tables WHERE table_schema = 'public' AND table_type = 'BASE TABLE';";
  const result = runDocker(['exec', '-i', containerName, 'psql', '-X', '-A', '-t', '-q', '-v', 'ON_ERROR_STOP=1', '-U', user, '-d', database, '-c', sql], runner);
  if (!result.ok) return { ok: false, count: null, error: result.stderr || result.error || 'psql failed' };
  const count = Number.parseInt(result.stdout, 10);
  return { ok: Number.isFinite(count), count: Number.isFinite(count) ? count : null };
}

function appRuntimeFiles(containerName, runner = spawnSync) {
  if (!containerName) return { ok: false, files: {}, error: 'missing container name' };
  const files = [
    '/app/scripts/serve-marketplace-homepage.js',
    '/app/scripts/remote-worker-postgres-store.js',
    '/app/scripts/marketplace-postgres-reader.js',
    '/app/scripts/marketplace-config-postgres-store.js',
    '/app/scripts/marketplace-workflow-postgres-store.js',
    '/app/scripts/marketplace-worker-events-postgres-store.js',
    '/app/scripts/marketplace-query-builders.js',
    '/app/scripts/postgres-price-sql.js',
    '/app/scripts/postgres-migration-status.js',
    '/app/scripts/postgres-cutover-inventory.js',
  ];
  const script = "const fs=require('fs'); const files=JSON.parse(process.argv[1]); console.log(JSON.stringify(Object.fromEntries(files.map((file)=>[file,fs.existsSync(file)]))));";
  const result = runDocker(['exec', containerName, 'node', '-e', script, JSON.stringify(files)], runner);
  if (!result.ok) return { ok: false, files: {}, error: result.stderr || result.error || 'docker exec failed' };
  try {
    const fileStatus = JSON.parse(result.stdout || '{}');
    return { ok: Object.values(fileStatus).every(Boolean), files: fileStatus };
  } catch (error) {
    return { ok: false, files: {}, error: error.message };
  }
}

function appPostgresEnvStatus(containerName, runner = spawnSync) {
  if (!containerName) return { ok: false, keys: {}, error: 'missing container name' };
  const keys = [
    'MARKETPLACE_POSTGRES_URL',
    'DATABASE_URL',
    'MARKETPLACE_REMOTE_WORKER_POSTGRES_URL',
    'MARKETPLACE_REMOTE_WORKER_STORE',
    'MARKETPLACE_REMOTE_WORKER_POSTGRES',
    'MARKETPLACE_LISTING_READ_STORE',
    'MARKETPLACE_LISTING_READ_POSTGRES',
    'MARKETPLACE_LISTING_READ_POSTGRES_URL',
    'MARKETPLACE_DB_DIALECT',
  ];
  const script = "const keys=JSON.parse(process.argv[1]); console.log(JSON.stringify(Object.fromEntries(keys.map((key)=>[key,Boolean(process.env[key])]))));";
  const result = runDocker(['exec', containerName, 'node', '-e', script, JSON.stringify(keys)], runner);
  if (!result.ok) return { ok: false, keys: {}, error: result.stderr || result.error || 'docker exec failed' };
  try {
    const keyStatus = JSON.parse(result.stdout || '{}');
    const hasConnection = Boolean(keyStatus.MARKETPLACE_POSTGRES_URL || keyStatus.DATABASE_URL || keyStatus.MARKETPLACE_REMOTE_WORKER_POSTGRES_URL || keyStatus.MARKETPLACE_LISTING_READ_POSTGRES_URL);
    const remoteWorkerPostgres = keyStatus.MARKETPLACE_REMOTE_WORKER_STORE || keyStatus.MARKETPLACE_REMOTE_WORKER_POSTGRES;
    const listingReadPostgres = keyStatus.MARKETPLACE_LISTING_READ_STORE || keyStatus.MARKETPLACE_LISTING_READ_POSTGRES;
    return { ok: hasConnection && remoteWorkerPostgres && listingReadPostgres, keys: keyStatus };
  } catch (error) {
    return { ok: false, keys: {}, error: error.message };
  }
}

function appPostgresReachability(containerName, runner = spawnSync) {
  if (!containerName) return { ok: false, status: 'missing_container_name' };
  const script = [
    "const net = require('net');",
    "const urlText = process.env.MARKETPLACE_LISTING_READ_POSTGRES_URL || process.env.MARKETPLACE_REMOTE_WORKER_POSTGRES_URL || process.env.MARKETPLACE_POSTGRES_URL || process.env.DATABASE_URL || '';",
    "if (!urlText) { console.log(JSON.stringify({ ok: false, status: 'missing_postgres_url' })); process.exit(0); }",
    "let parsed;",
    "try { parsed = new URL(urlText); } catch { console.log(JSON.stringify({ ok: false, status: 'invalid_postgres_url' })); process.exit(0); }",
    "const port = Number.parseInt(parsed.port || '5432', 10);",
    "const socket = net.createConnection({ host: parsed.hostname, port, timeout: 2000 });",
    "let done = false;",
    "function finish(ok, status) { if (done) return; done = true; console.log(JSON.stringify({ ok, status })); socket.destroy(); }",
    "socket.on('connect', () => finish(true, 'connect'));",
    "socket.on('timeout', () => finish(false, 'timeout'));",
    "socket.on('error', (error) => finish(false, error.code || 'error'));",
  ].join('\n');
  const result = runDocker(['exec', containerName, 'node', '-e', script], runner);
  if (!result.ok) return { ok: false, status: 'docker_exec_failed', error: result.stderr || result.error || '' };
  try {
    const parsed = JSON.parse(result.stdout || '{}');
    return { ok: parsed.ok === true, status: parsed.status || '' };
  } catch (error) {
    return { ok: false, status: 'invalid_probe_output', error: error.message };
  }
}


function verifyOutputStatus(filePath) {
  if (!fs.existsSync(filePath)) return { exists: false, ok: false, mismatches: null };
  const text = fs.readFileSync(filePath, 'utf8');
  const mismatches = /mismatch/i.test(text);
  const hasOk = /\bok\b/i.test(text);
  return { exists: true, ok: hasOk && !mismatches, mismatches };
}

function shadowCompareStatus(filePath) {
  if (!fs.existsSync(filePath)) return { exists: false, ok: false };
  const parsed = readJsonFile(filePath);
  if (parsed.error) return { exists: true, ok: false, error: parsed.error };
  return {
    exists: true,
    ok: parsed.ok === true,
    probeCount: parsed.probeCount ?? null,
    failed: parsed.failed ?? null,
  };
}

function buildStatusReport(options = {}, runner = spawnSync) {
  const projectDir = path.resolve(options.projectDir || process.cwd());
  const envFileOption = options.envFile || '.postgres-migration.env';
  const envFile = path.isAbsolute(envFileOption) ? envFileOption : path.join(projectDir, envFileOption);
  const env = readEnvFile(envFile);
  const postgresContainer = options.postgresContainer || env.MARKETPLACE_POSTGRES_CONTAINER || 'marketplace-postgres';
  const appContainer = options.appContainer || 'auto-browser';
  const postgresUser = env.MARKETPLACE_POSTGRES_USER || 'marketplace';
  const postgresDb = env.MARKETPLACE_POSTGRES_DB || 'marketplace';
  const migrationRoot = path.join(projectDir, 'artifacts', 'postgres-migration');
  const migrationName = options.migrationName || latestMigrationName(migrationRoot);
  const migrationDir = migrationName ? path.join(migrationRoot, migrationName) : '';
  const manifestPath = migrationDir ? path.join(migrationDir, 'manifest.json') : '';
  const verifyPath = migrationDir ? path.join(migrationDir, 'verify-output.txt') : '';
  const comparePath = migrationDir ? path.join(migrationDir, 'shadow-compare.json') : '';
  const manifest = manifestPath && fs.existsSync(manifestPath) ? readJsonFile(manifestPath) : null;
  const verify = verifyOutputStatus(verifyPath);
  const compare = shadowCompareStatus(comparePath);
  const container = inspectContainer(postgresContainer, runner);
  const appContainerStatus = inspectContainer(appContainer, runner);
  const ready = pgIsReady(postgresContainer, postgresUser, postgresDb, runner);
  const tableCount = postgresTableCount(postgresContainer, postgresUser, postgresDb, runner);
  const appFiles = appRuntimeFiles(appContainer, runner);
  const appEnv = appPostgresEnvStatus(appContainer, runner);
  const appReachability = appPostgresReachability(appContainer, runner);
  const requiredArtifactFiles = ['001_schema.sql', '002_load.sql', '003_verify.sql'];
  const artifactFiles = Object.fromEntries(requiredArtifactFiles.map((file) => [file, Boolean(migrationDir && fs.existsSync(path.join(migrationDir, file)))]));

  const checks = [
    check('project_dir', fs.existsSync(projectDir), { path: projectDir }),
    check('env_file', fs.existsSync(envFile), { path: envFile }),
    check('compose_overlay', fs.existsSync(path.join(projectDir, 'docker-compose.postgres.yml'))),
    check('shadow_script', fs.existsSync(path.join(projectDir, 'ops', 'postgres-prod-shadow-migration.sh'))),
    check('exporter_script', fs.existsSync(path.join(projectDir, 'scripts', 'export-marketplace-postgres-migration.js'))),
    check('compare_script', fs.existsSync(path.join(projectDir, 'scripts', 'compare-marketplace-postgres-shadow.js'))),
    check('postgres_container_exists', container.exists, { container: postgresContainer, error: container.error || '' }),
    check('postgres_container_running', container.running, { health: container.health || '' }),
    check('postgres_ready', ready.ok, { output: ready.output || '' }),
    check('app_container_exists', appContainerStatus.exists, { container: appContainer, error: appContainerStatus.error || '' }),
    check('app_container_running', appContainerStatus.running, { health: appContainerStatus.health || '' }),
    check('app_postgres_runtime_files', appFiles.ok, appFiles),
    check('app_postgres_env', appEnv.ok, appEnv),
    check('app_postgres_reachable', appReachability.ok, appReachability),
    check('migration_dir', Boolean(migrationDir && fs.existsSync(migrationDir)), { migrationName, path: migrationDir }),
    check('manifest', Boolean(manifest && !manifest.error), { path: manifestPath, tableCount: manifest?.tables?.length ?? null }),
    check('artifact_files', Object.values(artifactFiles).every(Boolean), { files: artifactFiles }),
    check('verify_output', verify.ok, verify),
    check('shadow_compare', compare.ok, compare),
    check('postgres_loaded_tables', tableCount.ok && tableCount.count > 0, tableCount),
  ];
  const ok = checks.every((item) => item.ok);
  return {
    ok,
    checkedAt: new Date().toISOString(),
    projectDir,
    envFile,
    postgres: {
      container: postgresContainer,
      user: postgresUser,
      database: postgresDb,
      running: container.running,
      health: container.health || '',
      ready: ready.ok,
      tableCount: tableCount.count,
    },
    app: {
      container: appContainer,
      running: appContainerStatus.running,
      health: appContainerStatus.health || '',
      postgresRuntimeFilesReady: appFiles.ok,
      postgresEnvReady: appEnv.ok,
      postgresReachable: appReachability.ok,
      postgresReachabilityStatus: appReachability.status || '',
    },
    migration: {
      name: migrationName,
      dir: migrationDir,
      manifestPath,
      verifyPath,
      shadowComparePath: comparePath,
      manifestTables: manifest?.tables?.length ?? null,
      manifestRows: Array.isArray(manifest?.tables) ? manifest.tables.reduce((sum, table) => sum + Number(table.rowCount || 0), 0) : null,
    },
    checks,
  };
}

function printTextReport(report) {
  process.stdout.write(`postgres_migration_status ok=${report.ok} migration=${report.migration.name || 'none'} postgres=${report.postgres.container}\n`);
  for (const item of report.checks) {
    process.stdout.write(`- ${item.ok ? 'ok' : 'FAIL'} ${item.name}\n`);
  }
}

function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  if (options.help) {
    usage();
    return 0;
  }
  const report = buildStatusReport(options);
  if (options.json) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } else {
    printTextReport(report);
  }
  return options.strict && !report.ok ? 1 : 0;
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
  parseArgs,
  readEnvFile,
  latestMigrationName,
  verifyOutputStatus,
  shadowCompareStatus,
  appRuntimeFiles,
  appPostgresEnvStatus,
  appPostgresReachability,
  buildStatusReport,
};
