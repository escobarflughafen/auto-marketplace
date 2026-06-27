const crypto = require('crypto');

function sha256(value) {
  return crypto.createHash('sha256').update(String(value || '')).digest('hex');
}

function timingSafeEqualText(left, right) {
  const leftBuffer = Buffer.from(String(left || ''), 'utf8');
  const rightBuffer = Buffer.from(String(right || ''), 'utf8');
  if (leftBuffer.length !== rightBuffer.length) return false;
  return crypto.timingSafeEqual(leftBuffer, rightBuffer);
}

function parseWorkerAuthorization(header) {
  const value = String(header || '').trim();
  if (!value) return { scheme: 'missing', token: '' };
  const match = value.match(/^Bearer\s+(.+)$/i);
  if (match) return { scheme: 'bearer', token: match[1].trim() };
  return { scheme: 'unsupported', token: '' };
}

function canonicalizeWorkerRequest(input) {
  return [
    String(input.method || '').toUpperCase(),
    String(input.pathWithQuery || ''),
    String(input.workerId || ''),
    String(input.timestamp || ''),
    String(input.nonce || ''),
    String(input.bodySha256 || ''),
  ].join('\n');
}

function createWorkerRequestSignature(input) {
  const body = String(input.body || '');
  const canonical = canonicalizeWorkerRequest({
    method: input.method,
    pathWithQuery: input.pathWithQuery,
    workerId: input.workerId,
    timestamp: input.timestamp,
    nonce: input.nonce,
    bodySha256: sha256(body),
  });
  return crypto
    .createHmac('sha256', String(input.tokenSecret || ''))
    .update(canonical)
    .digest('hex');
}

function error(code, message) {
  return {
    ok: false,
    error: { code, message },
  };
}

function verifyWorkerRequestAuth(request, options = {}) {
  const headers = request.headers || {};
  const parsed = parseWorkerAuthorization(headers.authorization);
  if (parsed.scheme !== 'bearer') {
    return error('invalid_worker_token', 'Missing or unsupported worker authorization.');
  }

  const tokenId = String(headers['x-worker-token-id'] || '').trim();
  const workerId = String(headers['x-worker-id'] || '').trim();
  const timestamp = String(headers['x-worker-timestamp'] || '').trim();
  const nonce = String(headers['x-worker-nonce'] || '').trim();
  const signature = String(headers['x-worker-signature'] || '').trim();
  if (!tokenId || !workerId || !timestamp || !nonce || !signature) {
    return error('invalid_worker_signature', 'Signed worker requests require token id, worker id, timestamp, nonce, and signature.');
  }

  const token = typeof options.lookupToken === 'function' ? options.lookupToken(tokenId) : null;
  if (!token || token.active === false) {
    return error('invalid_worker_token', 'Unknown or inactive worker token.');
  }
  if (token.workerId && token.workerId !== workerId) {
    return error('worker_id_mismatch', 'Worker id does not match token owner.');
  }
  const requiredScope = String(options.requiredScope || '').trim();
  if (requiredScope && !new Set(token.scopes || []).has(requiredScope)) {
    return error('worker_scope_denied', `Worker token lacks required scope: ${requiredScope}`);
  }

  const timestampMs = Date.parse(timestamp);
  if (!Number.isFinite(timestampMs)) {
    return error('invalid_worker_timestamp', 'Worker timestamp is not valid.');
  }
  const nowMs = (options.now instanceof Date ? options.now : new Date()).getTime();
  const skewMs = Number.isFinite(options.maxClockSkewMs) ? options.maxClockSkewMs : 5 * 60 * 1000;
  if (Math.abs(nowMs - timestampMs) > skewMs) {
    return error('worker_timestamp_out_of_range', 'Worker timestamp is outside the accepted clock skew.');
  }

  if (typeof options.hasSeenNonce === 'function' && options.hasSeenNonce(tokenId, nonce)) {
    return error('worker_nonce_replay', 'Worker nonce was already used.');
  }

  const expected = createWorkerRequestSignature({
    tokenSecret: token.secret,
    method: request.method,
    pathWithQuery: request.pathWithQuery,
    workerId,
    timestamp,
    nonce,
    body: request.body || '',
  });
  if (!timingSafeEqualText(signature, expected)) {
    return error('invalid_worker_signature', 'Worker request signature does not match.');
  }

  if (typeof options.markNonceSeen === 'function') {
    options.markNonceSeen(tokenId, nonce);
  }
  return {
    ok: true,
    tokenId,
    workerId,
    scopes: token.scopes || [],
  };
}

module.exports = {
  canonicalizeWorkerRequest,
  createWorkerRequestSignature,
  parseWorkerAuthorization,
  verifyWorkerRequestAuth,
};
