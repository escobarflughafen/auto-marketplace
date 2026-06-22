const test = require('node:test');
const assert = require('node:assert/strict');

const {
  buildWorkerProcessLogRecord,
  createWorkerProcessLogger,
  sanitizeValue,
  stringifyLogRecord,
} = require('../scripts/worker-process-logger');

function createMemoryStream() {
  return {
    chunks: [],
    write(chunk) {
      this.chunks.push(String(chunk));
    },
  };
}

function parseLines(stream) {
  return stream.chunks.join('').trim().split(/\n+/).filter(Boolean).map((line) => JSON.parse(line));
}

test('buildWorkerProcessLogRecord creates structured worker log records', () => {
  const record = buildWorkerProcessLogRecord({
    workerId: 'worker-1',
    sessionId: 'session-1',
    workerType: 'resolver',
    strategy: 'queue',
    component: 'event-sync',
  }, {
    ts: '2026-06-16T12:00:00.000Z',
    level: 'INFO',
    message: 'flush accepted',
    fields: {
      accepted: 10,
      ignored: undefined,
    },
  });

  assert.deepEqual(record, {
    ts: '2026-06-16T12:00:00.000Z',
    level: 'info',
    workerId: 'worker-1',
    sessionId: 'session-1',
    workerType: 'resolver',
    strategy: 'queue',
    component: 'event-sync',
    message: 'flush accepted',
    fields: {
      accepted: 10,
    },
  });
});

test('createWorkerProcessLogger writes info to stdout and warnings/errors to stderr', () => {
  const stdout = createMemoryStream();
  const stderr = createMemoryStream();
  const logger = createWorkerProcessLogger({
    workerId: 'worker-1',
    sessionId: 'session-1',
    workerType: 'resolver',
    strategy: 'queue',
    component: 'runtime',
    stdout,
    stderr,
    now: () => '2026-06-16T12:00:00.000Z',
  });

  logger.info('started', { pid: 123 });
  logger.warn('slow heartbeat', { elapsedMs: 1200 });
  logger.error('flush failed', { error: new Error('network down') });

  const stdoutRecords = parseLines(stdout);
  const stderrRecords = parseLines(stderr);

  assert.equal(stdoutRecords.length, 1);
  assert.equal(stdoutRecords[0].message, 'started');
  assert.equal(stdoutRecords[0].fields.pid, 123);

  assert.equal(stderrRecords.length, 2);
  assert.equal(stderrRecords[0].level, 'warn');
  assert.equal(stderrRecords[1].level, 'error');
  assert.equal(stderrRecords[1].fields.error.message, 'network down');
  assert.equal(stderrRecords[1].fields.error.name, 'Error');
});

test('createWorkerProcessLogger child context overrides component without losing worker identity', () => {
  const stdout = createMemoryStream();
  const stderr = createMemoryStream();
  const logger = createWorkerProcessLogger({
    workerId: 'worker-1',
    sessionId: 'session-1',
    workerType: 'backlog_indexer',
    strategy: 'resolved_metadata',
    component: 'runtime',
    stdout,
    stderr,
    now: () => '2026-06-16T12:00:00.000Z',
  });
  const child = logger.child({ component: 'metadata-indexer' });

  child.info('batch complete', { processed: 5 });

  const [record] = parseLines(stdout);
  assert.equal(record.workerId, 'worker-1');
  assert.equal(record.workerType, 'backlog_indexer');
  assert.equal(record.component, 'metadata-indexer');
  assert.equal(record.fields.processed, 5);
});

test('sanitizeValue redacts sensitive keys and handles circular values', () => {
  const input = {
    password: 'secret',
    token: 'abc',
    nested: {
      authToken: 'nested-token',
      safe: 'value',
    },
  };
  input.self = input;

  assert.deepEqual(sanitizeValue(input), {
    nested: {
      authToken: '[REDACTED]',
      safe: 'value',
    },
    password: '[REDACTED]',
    self: '[Circular]',
    token: '[REDACTED]',
  });
});

test('disabled logger does not write records', () => {
  const stdout = createMemoryStream();
  const logger = createWorkerProcessLogger({
    enabled: false,
    stdout,
  });

  const result = logger.info('hidden');

  assert.equal(result, null);
  assert.equal(stdout.chunks.length, 0);
});

test('stringifyLogRecord returns newline-delimited JSON', () => {
  assert.equal(
    stringifyLogRecord({ level: 'info', message: 'ok' }),
    '{"level":"info","message":"ok"}\n',
  );
});
