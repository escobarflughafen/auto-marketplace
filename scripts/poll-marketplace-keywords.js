const path = require('path');
const fs = require('fs');
const { spawnSync } = require('child_process');
const {
  ensureDir,
  slugify,
} = require('./marketplace-utils');
const {
  warnDeprecatedModule,
} = require('./marketplace-deprecation');

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

function normalizeListingKey(url) {
  const match = url.match(/\/marketplace\/item\/(\d+)/);
  return match ? match[1] : url;
}

function loadKeywordsFromFile(filePath) {
  const resolvedPath = path.isAbsolute(filePath)
    ? filePath
    : path.join(process.cwd(), filePath);
  const contents = fs.readFileSync(resolvedPath, 'utf8');
  return contents
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#'));
}

function timestampForPath(date = new Date()) {
  return date.toISOString().replace(/[:.]/g, '-');
}

function parseArgs(argv) {
  const options = {
    queries: [],
    keywordsFile: '',
    area: 'vancouver',
    captureRoot: path.join(process.cwd(), 'artifacts', 'marketplace-poll'),
    stateFile: '',
    logFile: '',
    detailLimit: 0,
    refreshSeconds: 30 * 60,
    maxItemsPerQueryCycle: 100,
    once: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    switch (arg) {
      case '--query':
        options.queries.push(readFlagValue(argv, index, arg));
        index += 1;
        break;
      case '--keywords-file':
        options.keywordsFile = readFlagValue(argv, index, arg);
        index += 1;
        break;
      case '--area':
        options.area = readFlagValue(argv, index, arg);
        index += 1;
        break;
      case '--capture-root':
        options.captureRoot = readFlagValue(argv, index, arg);
        index += 1;
        break;
      case '--state-file':
        options.stateFile = readFlagValue(argv, index, arg);
        index += 1;
        break;
      case '--log-file':
        options.logFile = readFlagValue(argv, index, arg);
        index += 1;
        break;
      case '--detail-limit':
        options.detailLimit = parseIntegerFlag(readFlagValue(argv, index, arg), arg, 0);
        index += 1;
        break;
      case '--visit-limit':
        options.detailLimit = parseIntegerFlag(readFlagValue(argv, index, arg), arg, 0);
        index += 1;
        break;
      case '--refresh-minutes':
        options.refreshSeconds = parseIntegerFlag(readFlagValue(argv, index, arg), arg, 1) * 60;
        index += 1;
        break;
      case '--interval-seconds':
        options.refreshSeconds = parseIntegerFlag(readFlagValue(argv, index, arg), arg, 1);
        index += 1;
        break;
      case '--max-items-per-query-cycle':
        options.maxItemsPerQueryCycle = parseIntegerFlag(readFlagValue(argv, index, arg), arg, 1);
        index += 1;
        break;
      case '--max-items-per-cycle':
        options.maxItemsPerQueryCycle = parseIntegerFlag(readFlagValue(argv, index, arg), arg, 1);
        index += 1;
        break;
      case '--once':
        options.once = true;
        break;
      default:
        throw new Error(`Unknown argument: ${arg}`);
    }
  }

  if (options.keywordsFile) {
    options.queries.push(...loadKeywordsFromFile(options.keywordsFile));
  }

  options.queries = Array.from(new Set(options.queries.map((query) => query.trim()).filter(Boolean)));
  if (options.queries.length < 1) {
    throw new Error(
      'Usage: node scripts/poll-marketplace-keywords.js --query "<text>" [--query "<text>"] [--keywords-file <file>] [--once]',
    );
  }

  options.captureRoot = path.isAbsolute(options.captureRoot)
    ? options.captureRoot
    : path.join(process.cwd(), options.captureRoot);
  options.stateFile = options.stateFile
    ? (path.isAbsolute(options.stateFile) ? options.stateFile : path.join(process.cwd(), options.stateFile))
    : path.join(options.captureRoot, 'state.json');
  options.logFile = options.logFile
    ? (path.isAbsolute(options.logFile) ? options.logFile : path.join(process.cwd(), options.logFile))
    : path.join(options.captureRoot, 'poller.log');

  return options;
}

function loadState(stateFile) {
  if (!fs.existsSync(stateFile)) {
    return { seen: {} };
  }

  try {
    const parsed = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
    return parsed && typeof parsed === 'object' ? parsed : { seen: {} };
  } catch (_) {
    return { seen: {} };
  }
}

async function saveState(stateFile, state) {
  await ensureDir(path.dirname(stateFile));
  await fs.promises.writeFile(stateFile, JSON.stringify(state, null, 2), 'utf8');
}

async function appendLog(logFile, message) {
  const line = `[${new Date().toISOString()}] ${message}\n`;
  process.stdout.write(line);
  await ensureDir(path.dirname(logFile));
  await fs.promises.appendFile(logFile, line, 'utf8');
}

function runNodeScript(scriptPath, args) {
  const result = spawnSync(process.execPath, [scriptPath, ...args], {
    cwd: process.cwd(),
    encoding: 'utf8',
    maxBuffer: 50 * 1024 * 1024,
    env: {
      ...process.env,
      MARKETPLACE_SUPPRESS_DEPRECATION_WARNING: '1',
    },
  });

  if (result.status !== 0) {
    const details = result.stderr || result.stdout || `exit code ${result.status}`;
    throw new Error(`${path.basename(scriptPath)} failed: ${details.trim()}`);
  }

  return result.stdout.trim();
}

async function writeQueryArtifacts(queryDir, querySummary) {
  const resultsPath = path.join(queryDir, 'results.json');
  await fs.promises.writeFile(resultsPath, JSON.stringify(querySummary, null, 2), 'utf8');

  const summaryPath = path.join(queryDir, 'summary.md');
  const lines = [
    `# ${querySummary.query}`,
    '',
    `- Area: ${querySummary.area}`,
    `- Captured at: ${querySummary.capturedAt}`,
    `- Total listings returned: ${querySummary.totalResults}`,
    `- New listings: ${querySummary.newResults}`,
    `- Detail captures: ${querySummary.detailCaptures}`,
    `- Hit item limit: ${querySummary.hitItemLimit ? 'yes' : 'no'}`,
    '',
    '## Listings',
    '',
  ];

  for (const item of querySummary.items) {
    lines.push(`- ${item.href}`);
  }

  await fs.promises.writeFile(summaryPath, `${lines.join('\n')}\n`, 'utf8');
  return { resultsPath, summaryPath };
}

async function writeRoundSummary(roundDir, summary) {
  const summaryPath = path.join(roundDir, 'summary.md');
  const lines = [
    '# Marketplace Poll Cycle',
    '',
    `- Captured at: ${summary.capturedAt}`,
    `- Area: ${summary.area}`,
    `- Queries: ${summary.queries.join(', ')}`,
    '',
    '## Results',
    '',
  ];

  for (const result of summary.results) {
    lines.push(`### ${result.query}`);
    lines.push('');
    lines.push(`- Total listings returned: ${result.totalResults}`);
    lines.push(`- New listings found: ${result.newResults}`);
    lines.push(`- Detail captures: ${result.detailCaptures}`);
    lines.push(`- Hit item limit: ${result.hitItemLimit ? 'yes' : 'no'}`);
    lines.push(`- Output dir: ${result.outputDir}`);
    lines.push('');
  }

  await fs.promises.writeFile(summaryPath, `${lines.join('\n')}\n`, 'utf8');
  return summaryPath;
}

async function runQueryCycle(query, options, state, roundDir) {
  const queryDir = path.join(roundDir, slugify(query));
  await ensureDir(queryDir);
  await appendLog(
    options.logFile,
    `query_start query="${query}" area=${options.area} max_items=${options.maxItemsPerQueryCycle} refresh_seconds=${options.refreshSeconds}`,
  );

  const stdout = runNodeScript(
    path.join(process.cwd(), 'scripts', 'extract-marketplace-results.js'),
    [
      query,
      '--area',
      options.area,
      '--max-items',
      String(options.maxItemsPerQueryCycle),
      '--max-runtime-seconds',
      String(options.refreshSeconds),
    ],
  );

  const items = JSON.parse(stdout);
  const seenSet = new Set(state.seen[query] || []);
  const freshItems = items.filter((item) => !seenSet.has(normalizeListingKey(item.href)));
  const itemsToCapture = freshItems.slice(0, options.detailLimit);
  const detailDir = path.join(queryDir, 'details');

  await appendLog(
    options.logFile,
    `query_results query="${query}" total=${items.length} new=${freshItems.length} detail_limit=${options.detailLimit}`,
  );

  if (itemsToCapture.length > 0) {
    await appendLog(
      options.logFile,
      `detail_capture_start query="${query}" count=${itemsToCapture.length} output_dir=${detailDir}`,
    );
    runNodeScript(
      path.join(process.cwd(), 'scripts', 'capture-marketplace-posts.js'),
      ['--capture-dir', detailDir, ...itemsToCapture.map((item) => item.href)],
    );
    await appendLog(
      options.logFile,
      `detail_capture_done query="${query}" captured=${itemsToCapture.length}`,
    );
  } else {
    await appendLog(options.logFile, `detail_capture_skip query="${query}" reason=no_new_items`);
  }

  for (const item of freshItems) {
    seenSet.add(normalizeListingKey(item.href));
  }
  state.seen[query] = Array.from(seenSet);
  await saveState(options.stateFile, state);
  await appendLog(options.logFile, `state_saved path=${options.stateFile} query="${query}" seen=${state.seen[query].length}`);

  const querySummary = {
    query,
    area: options.area,
    capturedAt: new Date().toISOString(),
    totalResults: items.length,
    newResults: freshItems.length,
    detailCaptures: itemsToCapture.length,
    hitItemLimit: items.length >= options.maxItemsPerQueryCycle,
    items,
    freshItems: freshItems.map((item) => item.href),
    outputDir: queryDir,
  };
  const artifacts = await writeQueryArtifacts(queryDir, querySummary);
  await appendLog(
    options.logFile,
    `query_done query="${query}" results_json=${artifacts.resultsPath} summary=${artifacts.summaryPath}`,
  );

  return {
    query,
    totalResults: querySummary.totalResults,
    newResults: querySummary.newResults,
    detailCaptures: querySummary.detailCaptures,
    hitItemLimit: querySummary.hitItemLimit,
    outputDir: queryDir,
    artifacts,
  };
}

async function runRound(options, state) {
  const roundTimestamp = new Date();
  const roundDir = path.join(options.captureRoot, timestampForPath(roundTimestamp));
  await ensureDir(roundDir);
  await appendLog(
    options.logFile,
    `round_start area=${options.area} queries=${options.queries.join(', ')} round_dir=${roundDir}`,
  );

  const results = [];
  for (const query of options.queries) {
    results.push(await runQueryCycle(query, options, state, roundDir));
  }

  const summaryPath = await writeRoundSummary(roundDir, {
    capturedAt: roundTimestamp.toISOString(),
    area: options.area,
    queries: options.queries,
    results,
  });
  await appendLog(options.logFile, `round_done summary=${summaryPath}`);

  return { roundDir, summaryPath, results };
}

async function sleep(ms) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function main() {
  warnDeprecatedModule({
    command: 'npm run marketplace:poll',
    replacement: 'npm run marketplace:search:explore -- --query "<seed keyword>"',
    note: 'Use the DB-backed search explorer for iterative keyword discovery and SQLite-backed history.',
  });
  const options = parseArgs(process.argv.slice(2));
  await ensureDir(options.captureRoot);
  await appendLog(
    options.logFile,
    `poller_start once=${options.once} refresh_seconds=${options.refreshSeconds} detail_limit=${options.detailLimit} max_items_per_query_cycle=${options.maxItemsPerQueryCycle} capture_root=${options.captureRoot}`,
  );

  const state = loadState(options.stateFile);
  await appendLog(options.logFile, `state_loaded path=${options.stateFile} tracked_queries=${Object.keys(state.seen || {}).length}`);

  do {
    const roundStartedAt = Date.now();
    const round = await runRound(options, state);
    console.log(JSON.stringify(round, null, 2));

    if (options.once) {
      await appendLog(options.logFile, 'poller_exit mode=once');
      break;
    }

    const shouldRefreshImmediately = round.results.some((result) => result.hitItemLimit);
    if (shouldRefreshImmediately) {
      await appendLog(options.logFile, 'poller_refresh reason=max_items_reached');
      continue;
    }

    const waitMs = Math.max(0, (options.refreshSeconds * 1000) - (Date.now() - roundStartedAt));
    await appendLog(options.logFile, `poller_sleep seconds=${Math.ceil(waitMs / 1000)} reason=refresh_timer`);
    await sleep(waitMs);
  } while (true);
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`[${new Date().toISOString()}] poller_error ${message}\n`);
  console.error(error.message);
  process.exit(1);
});
