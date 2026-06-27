const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');

const {
  canonicalizeWorkerRequest,
  createWorkerRequestSignature,
  parseWorkerAuthorization,
  verifyWorkerRequestAuth,
} = require('../scripts/remote-worker-auth');

const TOKEN = {
  tokenId: 'wrk_tok_test_001',
  workerId: 'backlog-indexer-host103-01',
  secret: 'test-worker-secret',
  scopes: [
    'remote_worker:session',
    'remote_worker:heartbeat',
    'remote_worker:events',
  ],
  active: true,
};

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

test('remote worker auth parses bearer tokens without accepting dashboard tokens implicitly', () => {
  assert.deepEqual(parseWorkerAuthorization('Bearer wrk_secret_123'), {
    scheme: 'bearer',
    token: 'wrk_secret_123',
  });
  assert.equal(parseWorkerAuthorization('').scheme, 'missing');
  assert.equal(parseWorkerAuthorization('Basic abc').scheme, 'unsupported');
});

test('remote worker auth canonicalizes signed request fields deterministically', () => {
  const canonical = canonicalizeWorkerRequest({
    method: 'POST',
    pathWithQuery: '/api/v2/remote-workers/sessions/session-1/events?dryRun=0',
    workerId: TOKEN.workerId,
    timestamp: '2026-06-26T12:00:00.000Z',
    nonce: 'nonce-1',
    bodySha256: sha256('{"ok":true}'),
  });

  assert.equal(canonical, [
    'POST',
    '/api/v2/remote-workers/sessions/session-1/events?dryRun=0',
    TOKEN.workerId,
    '2026-06-26T12:00:00.000Z',
    'nonce-1',
    sha256('{"ok":true}'),
  ].join('\n'));
});

test('remote worker auth verifies HMAC signature, timestamp, scope, and nonce replay', () => {
  const body = JSON.stringify({ workerId: TOKEN.workerId, events: [] });
  const timestamp = '2026-06-26T12:00:00.000Z';
  const nonce = 'nonce-accepted';
  const request = {
    method: 'POST',
    pathWithQuery: '/api/v2/remote-workers/sessions/session-1/events',
    body,
    headers: {
      authorization: `Bearer ${TOKEN.secret}`,
      'x-worker-id': TOKEN.workerId,
      'x-worker-token-id': TOKEN.tokenId,
      'x-worker-timestamp': timestamp,
      'x-worker-nonce': nonce,
    },
  };
  request.headers['x-worker-signature'] = createWorkerRequestSignature({
    tokenSecret: TOKEN.secret,
    method: request.method,
    pathWithQuery: request.pathWithQuery,
    workerId: TOKEN.workerId,
    timestamp,
    nonce,
    body,
  });

  const usedNonces = new Set();
  const result = verifyWorkerRequestAuth(request, {
    now: new Date('2026-06-26T12:01:00.000Z'),
    requiredScope: 'remote_worker:events',
    lookupToken: (tokenId) => (tokenId === TOKEN.tokenId ? TOKEN : null),
    hasSeenNonce: (tokenId, candidateNonce) => usedNonces.has(`${tokenId}:${candidateNonce}`),
    markNonceSeen: (tokenId, candidateNonce) => usedNonces.add(`${tokenId}:${candidateNonce}`),
  });

  assert.equal(result.ok, true);
  assert.equal(result.workerId, TOKEN.workerId);
  assert.equal(result.tokenId, TOKEN.tokenId);

  const replay = verifyWorkerRequestAuth(request, {
    now: new Date('2026-06-26T12:01:01.000Z'),
    requiredScope: 'remote_worker:events',
    lookupToken: (tokenId) => (tokenId === TOKEN.tokenId ? TOKEN : null),
    hasSeenNonce: (tokenId, candidateNonce) => usedNonces.has(`${tokenId}:${candidateNonce}`),
    markNonceSeen: () => {},
  });

  assert.equal(replay.ok, false);
  assert.equal(replay.error.code, 'worker_nonce_replay');
});

test('remote worker auth rejects worker id mismatch and missing route scope', () => {
  const body = JSON.stringify({ workerId: 'other-worker', events: [] });
  const timestamp = '2026-06-26T12:00:00.000Z';
  const nonce = 'nonce-worker-mismatch';
  const signature = createWorkerRequestSignature({
    tokenSecret: TOKEN.secret,
    method: 'POST',
    pathWithQuery: '/api/v2/remote-workers/sessions/session-1/events',
    workerId: 'other-worker',
    timestamp,
    nonce,
    body,
  });

  const result = verifyWorkerRequestAuth({
    method: 'POST',
    pathWithQuery: '/api/v2/remote-workers/sessions/session-1/events',
    body,
    headers: {
      authorization: `Bearer ${TOKEN.secret}`,
      'x-worker-id': 'other-worker',
      'x-worker-token-id': TOKEN.tokenId,
      'x-worker-timestamp': timestamp,
      'x-worker-nonce': nonce,
      'x-worker-signature': signature,
    },
  }, {
    now: new Date('2026-06-26T12:00:10.000Z'),
    requiredScope: 'remote_worker:claims',
    lookupToken: (tokenId) => (tokenId === TOKEN.tokenId ? TOKEN : null),
    hasSeenNonce: () => false,
    markNonceSeen: () => {},
  });

  assert.equal(result.ok, false);
  assert.match(result.error.code, /worker_id_mismatch|worker_scope_denied/);
});
