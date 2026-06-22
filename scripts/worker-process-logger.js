const DEFAULT_REDACTED_KEYS = new Set([
  'authorization',
  'cookie',
  'credentials',
  'credentialsPath',
  'credentialsProfile',
  'password',
  'secret',
  'token',
  'workerToken',
  'workerTokenEnv',
]);

const STDERR_LEVELS = new Set(['warn', 'error', 'fatal']);

function nowIso() {
  return new Date().toISOString();
}

function normalizeLevel(level) {
  const normalized = String(level || '').trim().toLowerCase();
  return normalized || 'info';
}

function shouldRedactKey(key, redactedKeys = DEFAULT_REDACTED_KEYS) {
  const normalized = String(key || '').trim();
  if (redactedKeys.has(normalized)) {
    return true;
  }
  const lower = normalized.toLowerCase();
  return lower.includes('password')
    || lower.includes('token')
    || lower.includes('secret')
    || lower.includes('cookie')
    || lower === 'authorization';
}

function serializeError(error) {
  if (!(error instanceof Error)) {
    return error;
  }
  return {
    name: error.name || 'Error',
    message: error.message || '',
    stack: error.stack || '',
    code: error.code || '',
  };
}

function sanitizeValue(value, options = {}, seen = new WeakSet()) {
  const redactedKeys = options.redactedKeys || DEFAULT_REDACTED_KEYS;
  if (value instanceof Error) {
    return sanitizeValue(serializeError(value), options, seen);
  }
  if (value === undefined) {
    return undefined;
  }
  if (value === null || typeof value !== 'object') {
    return value;
  }
  if (seen.has(value)) {
    return '[Circular]';
  }
  seen.add(value);
  if (Array.isArray(value)) {
    return value
      .map((item) => sanitizeValue(item, options, seen))
      .filter((item) => item !== undefined);
  }
  return Object.keys(value).sort().reduce((record, key) => {
    if (shouldRedactKey(key, redactedKeys)) {
      record[key] = '[REDACTED]';
      return record;
    }
    const sanitized = sanitizeValue(value[key], options, seen);
    if (sanitized !== undefined) {
      record[key] = sanitized;
    }
    return record;
  }, {});
}

function buildWorkerProcessLogRecord(base = {}, entry = {}, options = {}) {
  const level = normalizeLevel(entry.level || base.level);
  const fields = sanitizeValue(entry.fields || {}, options);
  const record = sanitizeValue({
    ts: entry.ts || base.ts || (options.now ? options.now() : nowIso()),
    level,
    workerId: entry.workerId || base.workerId || '',
    sessionId: entry.sessionId || base.sessionId || '',
    workerType: entry.workerType || base.workerType || '',
    strategy: entry.strategy || base.strategy || '',
    component: entry.component || base.component || '',
    message: String(entry.message || ''),
    fields,
  }, options);
  return record;
}

function stringifyLogRecord(record) {
  return `${JSON.stringify(record)}\n`;
}

function createWorkerProcessLogger(options = {}) {
  const {
    stdout = process.stdout,
    stderr = process.stderr,
    enabled = true,
    redactedKeys = DEFAULT_REDACTED_KEYS,
    now,
    ...baseContext
  } = options;

  const writeRecord = (entry = {}) => {
    if (!enabled) {
      return null;
    }
    const record = buildWorkerProcessLogRecord(baseContext, entry, { redactedKeys, now });
    const stream = STDERR_LEVELS.has(record.level) ? stderr : stdout;
    try {
      stream.write(stringifyLogRecord(record));
    } catch (_) {
      return record;
    }
    return record;
  };

  const logger = {
    log(level, message, fields = {}, context = {}) {
      return writeRecord({
        ...context,
        level,
        message,
        fields,
      });
    },
    debug(message, fields = {}, context = {}) {
      return this.log('debug', message, fields, context);
    },
    info(message, fields = {}, context = {}) {
      return this.log('info', message, fields, context);
    },
    warn(message, fields = {}, context = {}) {
      return this.log('warn', message, fields, context);
    },
    error(message, fields = {}, context = {}) {
      return this.log('error', message, fields, context);
    },
    child(context = {}) {
      return createWorkerProcessLogger({
        ...baseContext,
        ...context,
        stdout,
        stderr,
        enabled,
        redactedKeys,
        now,
      });
    },
  };
  return logger;
}

module.exports = {
  DEFAULT_REDACTED_KEYS,
  buildWorkerProcessLogRecord,
  createWorkerProcessLogger,
  sanitizeValue,
  stringifyLogRecord,
};
