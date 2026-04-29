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

function timestampForPath(date = new Date()) {
  return date.toISOString().replace(/[:.]/g, '-');
}

function parseArgs(argv) {
  const options = {
    query: '',
    area: 'vancouver',
    captureRoot: path.join(process.cwd(), 'artifacts', 'marketplace-keyword-collector'),
    stateFile: '',
    logFile: '',
    maxItemsPerCycle: 100,
    refreshMinutes: 30,
    detailLimit: 0,
    once: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];

    if (!options.query && !arg.startsWith('--')) {
      options.query = arg;
      continue;
    }

    switch (arg) {
      case '--query':
        options.query = readFlagValue(argv, index, arg);
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
      case '--max-items-per-cycle':
        options.maxItemsPerCycle = parseIntegerFlag(readFlagValue(argv, index, arg), arg, 1);
        index += 1;
        break;
      case '--refresh-minutes':
        options.refreshMinutes = parseIntegerFlag(readFlagValue(argv, index, arg), arg, 1);
        index += 1;
        break;
      case '--detail-limit':
        options.detailLimit = parseIntegerFlag(readFlagValue(argv, index, arg), arg, 0);
        index += 1;
        break;
      case '--once':
        options.once = true;
        break;
      default:
        throw new Error(`Unknown argument: ${arg}`);
    }
  }

  if (!options.query) {
    throw new Error(
      'Usage: node scripts/collect-marketplace-keyword.js --query "<text>" [--area vancouver --max-items-per-cycle 100 --refresh-minutes 30]',
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
    : path.join(options.captureRoot, 'collector.log');

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

async function writeCycleArtifacts(cycleDir, cycleSummary) {
  const jsonPath = path.join(cycleDir, 'results.json');
  await fs.promises.writeFile(jsonPath, JSON.stringify(cycleSummary, null, 2), 'utf8');

  const markdownPath = path.join(cycleDir, 'summary.md');
  const lines = [
    '# Marketplace Keyword Collection Cycle',
    '',
    `- Query: ${cycleSummary.query}`,
    `- Area: ${cycleSummary.area}`,
    `- Captured at: ${cycleSummary.capturedAt}`,
    `- Total listings returned: ${cycleSummary.totalResults}`,
    `- New listings: ${cycleSummary.newResults}`,
    `- Detail captures: ${cycleSummary.detailCaptures}`,
    `- Refreshed early at item limit: ${cycleSummary.hitItemLimit ? 'yes' : 'no'}`,
    '',
    '## Listings',
    '',
  ];

  for (const item of cycleSummary.items) {
    lines.push(`- ${item.href}`);
  }

  await fs.promises.writeFile(markdownPath, `${lines.join('\n')}\n`, 'utf8');
  return { jsonPath, markdownPath };
}

async function runCycle(options, state) {
  const cycleStartedAt = new Date();
  const cycleDir = path.join(options.captureRoot, timestampForPath(cycleStartedAt), slugify(options.query));
  await ensureDir(cycleDir);
  await appendLog(
    options.logFile,
    `cycle_start query="${options.query}" area=${options.area} cycle_dir=${cycleDir} max_items=${options.maxItemsPerCycle} refresh_minutes=${options.refreshMinutes}`,
  );

  const stdout = runNodeScript(
    path.join(process.cwd(), 'scripts', 'extract-marketplace-results.js'),
    [
      options.query,
      '--area',
      options.area,
      '--max-items',
      String(options.maxItemsPerCycle),
      '--max-runtime-seconds',
      String(options.refreshMinutes * 60),
    ],
  );

  const items = JSON.parse(stdout);
  const seenSet = new Set(state.seen[options.query] || []);
  const freshItems = items.filter((item) => !seenSet.has(normalizeListingKey(item.href)));
  const itemsToCapture = freshItems.slice(0, options.detailLimit);
  const detailDir = path.join(cycleDir, 'details');

  await appendLog(
    options.logFile,
    `cycle_results query="${options.query}" total=${items.length} new=${freshItems.length} detail_limit=${options.detailLimit}`,
  );

  if (itemsToCapture.length > 0) {
    await appendLog(
      options.logFile,
      `detail_capture_start query="${options.query}" count=${itemsToCapture.length} output_dir=${detailDir}`,
    );
    runNodeScript(
      path.join(process.cwd(), 'scripts', 'capture-marketplace-posts.js'),
      ['--capture-dir', detailDir, ...itemsToCapture.map((item) => item.href)],
    );
    await appendLog(
      options.logFile,
      `detail_capture_done query="${options.query}" captured=${itemsToCapture.length}`,
    );
  } else {
    await appendLog(options.logFile, `detail_capture_skip query="${options.query}" reason=no_new_items`);
  }

  for (const item of freshItems) {
    seenSet.add(normalizeListingKey(item.href));
  }
  state.seen[options.query] = Array.from(seenSet);
  await saveState(options.stateFile, state);

  const cycleSummary = {
    query: options.query,
    area: options.area,
    capturedAt: cycleStartedAt.toISOString(),
    totalResults: items.length,
    newResults: freshItems.length,
    detailCaptures: itemsToCapture.length,
    hitItemLimit: items.length >= options.maxItemsPerCycle,
    items,
    freshItems: freshItems.map((item) => item.href),
  };
  const artifacts = await writeCycleArtifacts(cycleDir, cycleSummary);

  await appendLog(
    options.logFile,
    `cycle_done query="${options.query}" results_json=${artifacts.jsonPath} summary=${artifacts.markdownPath}`,
  );

  return {
    cycleDir,
    artifacts,
    hitItemLimit: cycleSummary.hitItemLimit,
    totalResults: cycleSummary.totalResults,
    newResults: cycleSummary.newResults,
    detailCaptures: cycleSummary.detailCaptures,
  };
}

async function sleep(ms) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function main() {
  warnDeprecatedModule({
    command: 'npm run marketplace:collect',
    replacement: 'npm run marketplace:search:explore -- --query "<keyword>"',
    note: 'Use the DB-backed search explorer for persistent storage, keyword indexing, and backlog processing.',
  });
  const options = parseArgs(process.argv.slice(2));
  await ensureDir(options.captureRoot);
  await appendLog(
    options.logFile,
    `collector_start query="${options.query}" area=${options.area} capture_root=${options.captureRoot} refresh_minutes=${options.refreshMinutes} max_items_per_cycle=${options.maxItemsPerCycle}`,
  );

  const state = loadState(options.stateFile);
  await appendLog(options.logFile, `state_loaded path=${options.stateFile} tracked_queries=${Object.keys(state.seen || {}).length}`);

  do {
    const cycleStartedAt = Date.now();
    const cycle = await runCycle(options, state);
    console.log(JSON.stringify(cycle, null, 2));

    if (options.once) {
      await appendLog(options.logFile, 'collector_exit mode=once');
      break;
    }

    if (cycle.hitItemLimit) {
      await appendLog(options.logFile, 'collector_refresh reason=max_items_reached');
      continue;
    }

    const refreshMs = options.refreshMinutes * 60 * 1000;
    const waitMs = Math.max(0, refreshMs - (Date.now() - cycleStartedAt));
    await appendLog(options.logFile, `collector_sleep seconds=${Math.ceil(waitMs / 1000)} reason=refresh_timer`);
    await sleep(waitMs);
  } while (true);
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`[${new Date().toISOString()}] collector_error ${message}\n`);
  console.error(error.message);
  process.exit(1);
});
