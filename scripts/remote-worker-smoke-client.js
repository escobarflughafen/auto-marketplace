#!/usr/bin/env node
const net = require('net');
const crypto = require('crypto');

function usage() {
  process.stdout.write(`Usage:
  node scripts/remote-worker-smoke-client.js --host-url http://127.0.0.1:21435 --worker-token TOKEN [options]

Options:
  --worker-id ID          Default: smoke-worker-<hostname-ish timestamp>
  --worker-type TYPE      Default: backlog_indexer
  --strategy STRATEGY     Default: resolved_metadata
  --listing-id ID         Optional listing id for listing event projection
  --source-id ID          Default: remote-worker-smoke
  --timeout-ms N          Default: 5000
  --json                  Print JSON result only
`);
}

function readArg(argv, index, flag) {
  const value = argv[index + 1];
  if (!value || value.startsWith('--')) {
    throw new Error(`Missing value for ${flag}`);
  }
  return value;
}

function parseArgs(argv) {
  const options = {
    hostUrl: process.env.REMOTE_WORKER_HOST_URL || 'http://127.0.0.1:21435',
    workerToken: process.env.MARKETPLACE_REMOTE_WORKER_TOKEN || '',
    workerId: '',
    workerType: 'backlog_indexer',
    strategy: 'resolved_metadata',
    listingId: '',
    sourceId: 'remote-worker-smoke',
    timeoutMs: 5000,
    json: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    switch (arg) {
      case '--host-url':
        options.hostUrl = readArg(argv, index, arg);
        index += 1;
        break;
      case '--worker-token':
        options.workerToken = readArg(argv, index, arg);
        index += 1;
        break;
      case '--worker-id':
        options.workerId = readArg(argv, index, arg);
        index += 1;
        break;
      case '--worker-type':
        options.workerType = readArg(argv, index, arg);
        index += 1;
        break;
      case '--strategy':
        options.strategy = readArg(argv, index, arg);
        index += 1;
        break;
      case '--listing-id':
        options.listingId = readArg(argv, index, arg);
        index += 1;
        break;
      case '--source-id':
        options.sourceId = readArg(argv, index, arg);
        index += 1;
        break;
      case '--timeout-ms':
        options.timeoutMs = Number.parseInt(readArg(argv, index, arg), 10);
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
  if (!options.workerId) {
    options.workerId = `smoke-worker-${Date.now().toString(36)}`;
  }
  if (!options.workerToken) {
    throw new Error('Missing --worker-token or MARKETPLACE_REMOTE_WORKER_TOKEN');
  }
  if (!Number.isFinite(options.timeoutMs) || options.timeoutMs < 100) {
    throw new Error('--timeout-ms must be >= 100');
  }
  return options;
}

function parseHttpResponse(raw) {
  const splitAt = raw.indexOf('\r\n\r\n');
  if (splitAt < 0) {
    throw new Error('Invalid HTTP response: missing header terminator');
  }
  const headerText = raw.slice(0, splitAt);
  const bodyText = raw.slice(splitAt + 4);
  const [statusLine, ...headerLines] = headerText.split('\r\n');
  const statusMatch = statusLine.match(/^HTTP\/\d(?:\.\d)?\s+(\d+)/);
  if (!statusMatch) {
    throw new Error(`Invalid HTTP status line: ${statusLine}`);
  }
  const headers = {};
  for (const line of headerLines) {
    const colon = line.indexOf(':');
    if (colon > 0) {
      headers[line.slice(0, colon).trim().toLowerCase()] = line.slice(colon + 1).trim();
    }
  }
  const decodedBody = headers['transfer-encoding']?.toLowerCase() === 'chunked'
    ? decodeChunkedBody(bodyText)
    : bodyText;
  const body = decodedBody.trim() ? JSON.parse(decodedBody) : null;
  return {
    status: Number(statusMatch[1]),
    headers,
    body,
  };
}

function decodeChunkedBody(bodyText) {
  let offset = 0;
  let decoded = '';
  while (offset < bodyText.length) {
    const lineEnd = bodyText.indexOf('\r\n', offset);
    if (lineEnd < 0) break;
    const sizeText = bodyText.slice(offset, lineEnd).split(';')[0].trim();
    const size = Number.parseInt(sizeText, 16);
    if (!Number.isFinite(size)) {
      throw new Error(`Invalid chunk size: ${sizeText}`);
    }
    offset = lineEnd + 2;
    if (size === 0) break;
    decoded += bodyText.slice(offset, offset + size);
    offset += size + 2;
  }
  return decoded;
}

function tcpJsonRequest(baseUrl, pathname, token, body, timeoutMs) {
  const url = new URL(pathname, baseUrl);
  if (url.protocol !== 'http:') {
    throw new Error('TCP smoke client currently supports plain http:// URLs only');
  }
  const payload = JSON.stringify(body || {});
  const port = Number(url.port || 80);
  const hostHeader = url.port ? `${url.hostname}:${url.port}` : url.hostname;
  const requestText = [
    `POST ${url.pathname}${url.search} HTTP/1.1`,
    `Host: ${hostHeader}`,
    'Connection: close',
    'Content-Type: application/json',
    `Content-Length: ${Buffer.byteLength(payload)}`,
    `Authorization: Bearer ${token}`,
    'User-Agent: remote-worker-smoke-client/1',
    '',
    payload,
  ].join('\r\n');

  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ host: url.hostname, port });
    const chunks = [];
    const timeout = setTimeout(() => {
      socket.destroy(new Error(`TCP request timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    socket.on('connect', () => socket.write(requestText));
    socket.on('data', (chunk) => chunks.push(chunk));
    socket.on('error', (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    socket.on('close', () => {
      clearTimeout(timeout);
      try {
        resolve(parseHttpResponse(Buffer.concat(chunks).toString('utf8')));
      } catch (error) {
        reject(error);
      }
    });
  });
}

function expectStatus(label, response, expected) {
  if (response.status !== expected) {
    const message = response.body?.error?.message || response.body?.error || JSON.stringify(response.body);
    throw new Error(`${label} returned HTTP ${response.status}, expected ${expected}: ${message}`);
  }
  return response.body;
}

async function run(options) {
  const startedAt = new Date();
  const registered = expectStatus('session register', await tcpJsonRequest(
    options.hostUrl,
    '/api/v2/remote-workers/sessions',
    options.workerToken,
    {
      workerId: options.workerId,
      workerType: options.workerType,
      strategy: options.strategy,
      workerVersion: 'smoke-client@1',
      sourceId: options.sourceId,
      capabilities: {
        apiVersion: 'v2',
        transport: 'tcp-http',
        localOutbox: true,
      },
      lastCheckpoint: {
        lastAckedSequence: 0,
      },
    },
    options.timeoutMs,
  ), 201);

  const sessionId = registered.sessionId;
  const heartbeat = expectStatus('heartbeat', await tcpJsonRequest(
    options.hostUrl,
    `/api/v2/remote-workers/sessions/${encodeURIComponent(sessionId)}/heartbeat`,
    options.workerToken,
    {
      workerId: options.workerId,
      runtimeState: 'smoke_test',
      lastLocalSequence: options.listingId ? 2 : 1,
      lastAckedSequence: 0,
      pendingEventCount: options.listingId ? 2 : 1,
    },
    options.timeoutMs,
  ), 200);

  const eventPrefix = `${options.workerId}:${Date.now().toString(36)}:${crypto.randomBytes(4).toString('hex')}`;
  const events = [{
    eventId: `${eventPrefix}:started`,
    sequence: 1,
    eventAt: new Date(startedAt.getTime() + 1000).toISOString(),
    eventScope: 'workflow',
    eventType: 'worker_started',
    status: 'running',
    payload: {
      workerType: options.workerType,
      strategy: options.strategy,
      mode: 'remote-worker-smoke',
    },
  }];
  if (options.listingId) {
    events.push({
      eventId: `${eventPrefix}:indexed`,
      sequence: 2,
      eventAt: new Date(startedAt.getTime() + 2000).toISOString(),
      eventScope: 'listing',
      eventType: 'backlog_listing_metadata_skipped',
      listingId: options.listingId,
      status: 'skipped',
      payload: {
        reason: 'smoke_test_no_mutation',
        indexerVersion: 'smoke-client@1',
      },
    });
  }

  const ingested = expectStatus('event ingest', await tcpJsonRequest(
    options.hostUrl,
    `/api/v2/remote-workers/sessions/${encodeURIComponent(sessionId)}/events`,
    options.workerToken,
    {
      workerId: options.workerId,
      batchId: `${eventPrefix}:batch`,
      events,
    },
    options.timeoutMs,
  ), 200);

  const artifact = expectStatus('artifact manifest', await tcpJsonRequest(
    options.hostUrl,
    `/api/v2/remote-workers/sessions/${encodeURIComponent(sessionId)}/artifacts`,
    options.workerToken,
    {
      workerId: options.workerId,
      artifacts: [{
        exchangeType: 'artifact_manifest',
        schemaVersion: 'remote-worker-artifact@1',
        artifactId: `${eventPrefix}:artifact`,
        eventId: events[events.length - 1].eventId,
        artifactType: 'image',
        mediaRole: options.listingId ? 'listing_photo' : 'worker_screenshot',
        contentType: 'image/jpeg',
        sha256: crypto.createHash('sha256').update(`${eventPrefix}:artifact`).digest('hex'),
        sizeBytes: 0,
        metadata: {
          listingId: options.listingId,
          smokeTest: true,
        },
        storage: {
          requestedBackend: 'local_fs',
          uploadMode: 'metadata_only',
        },
      }],
    },
    options.timeoutMs,
  ), 200);

  return {
    ok: true,
    transport: 'tcp-http',
    hostUrl: options.hostUrl,
    workerId: options.workerId,
    sessionId,
    registered,
    heartbeat,
    ingested,
    artifact,
  };
}

async function main() {
  try {
    const options = parseArgs(process.argv.slice(2));
    const result = await run(options);
    if (options.json) {
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    } else {
      process.stdout.write(`Remote worker TCP smoke passed: ${result.sessionId}\n`);
      process.stdout.write(`Accepted events: ${result.ingested.accepted.length}, duplicates: ${result.ingested.duplicates.length}\n`);
      process.stdout.write(`Accepted artifacts: ${result.artifact.accepted.length}, duplicates: ${result.artifact.duplicates.length}\n`);
    }
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exit(1);
  }
}

if (require.main === module) {
  main();
}

module.exports = {
  parseArgs,
  tcpJsonRequest,
  run,
};
