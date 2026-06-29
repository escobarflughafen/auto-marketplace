const crypto = require('crypto');

function safeJson(value) {
  return JSON.stringify(value ?? {});
}

function parseListingDetailJson(row) {
  try {
    const parsed = JSON.parse(row?.detail_json || '{}');
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function boundedInteger(value, fallback, min, max) {
  const parsed = Number.parseInt(value, 10);
  const next = Number.isFinite(parsed) ? parsed : fallback;
  return Math.max(min, Math.min(next, max));
}

function randomId(prefix) {
  return `${prefix}-${Date.now().toString(36)}-${crypto.randomBytes(6).toString('hex')}`;
}

function buildRemoteCommandId() {
  return randomId('remote-command');
}

function buildRemoteClaimId() {
  return randomId('remote-claim');
}

function buildRemoteLeaseId() {
  return randomId('remote-lease');
}

function requirePgPool() {
  try {
    return require('pg').Pool;
  } catch (error) {
    const wrapped = new Error('PostgreSQL remote worker store requires the pg package or an injected pool.');
    wrapped.cause = error;
    wrapped.code = 'missing_pg_dependency';
    throw wrapped;
  }
}

async function queryRows(client, sql, params = []) {
  const result = await client.query(sql, params);
  return result.rows || [];
}

async function queryOne(client, sql, params = []) {
  const rows = await queryRows(client, sql, params);
  return rows[0] || null;
}

function makeHttpError(message, statusCode, code) {
  const error = new Error(message);
  error.statusCode = statusCode;
  error.code = code;
  return error;
}

function remoteBacklogIndexerAccepted(body = {}) {
  const acceptedCommandTypes = Array.isArray(body.acceptedCommandTypes)
    ? body.acceptedCommandTypes.map((value) => String(value || '').trim()).filter(Boolean)
    : [];
  return acceptedCommandTypes.length === 0
    || acceptedCommandTypes.includes('index_resolved_listing_metadata_batch');
}

function remoteBacklogIndexerPayloadItem(row) {
  const detail = parseListingDetailJson(row);
  const listingContent = detail.listingContent && typeof detail.listingContent === 'object'
    ? detail.listingContent
    : {};
  const title = String(row.detail_title || listingContent.title || row.card_title || '').trim();
  const text = String(listingContent.description || listingContent.text || row.card_text || '').trim();
  const payloadCore = {
    listingId: row.listing_id,
    href: row.href,
    title,
    price: row.detail_price || listingContent.price || '',
    description: text,
    detailListedAgo: row.detail_listed_ago || '',
    detailLocation: row.detail_location || listingContent.location || '',
    detailCondition: row.detail_condition || listingContent.condition || '',
    resolvedAt: row.detail_completed_at || row.last_seen_at || row.first_seen_at || '',
    firstSeenAt: row.first_seen_at || '',
    lastSeenAt: row.last_seen_at || '',
    source: row.source || '',
    sourceKeyword: row.source_keyword || '',
    snapshotPath: row.snapshot_path || '',
  };
  return {
    ...payloadCore,
    contentHash: crypto.createHash('sha256').update(safeJson(payloadCore)).digest('hex'),
  };
}

function createPoolFromOptions(options = {}) {
  if (options.pool) return options.pool;
  const connectionString = options.connectionString || process.env.MARKETPLACE_POSTGRES_URL || process.env.DATABASE_URL || '';
  if (!connectionString) {
    const error = new Error('Missing PostgreSQL connection string. Set MARKETPLACE_POSTGRES_URL or pass connectionString.');
    error.code = 'missing_postgres_connection_string';
    throw error;
  }
  const Pool = requirePgPool();
  return new Pool({ connectionString });
}

function createRemoteWorkerPostgresStore(options = {}) {
  const pool = createPoolFromOptions(options);
  const idFactory = {
    commandId: options.idFactory?.commandId || buildRemoteCommandId,
    claimId: options.idFactory?.claimId || buildRemoteClaimId,
    leaseId: options.idFactory?.leaseId || buildRemoteLeaseId,
  };
  const nowIso = options.nowIso || (() => new Date().toISOString());

  async function withTransaction(callback) {
    if (typeof pool.connect === 'function') {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const result = await callback(client);
        await client.query('COMMIT');
        return result;
      } catch (error) {
        await client.query('ROLLBACK').catch(() => {});
        throw error;
      } finally {
        client.release();
      }
    }
    await pool.query('BEGIN');
    try {
      const result = await callback(pool);
      await pool.query('COMMIT');
      return result;
    } catch (error) {
      await pool.query('ROLLBACK').catch(() => {});
      throw error;
    }
  }

  async function getRemoteWorkerSession(sessionId, client = pool) {
    return queryOne(client, `
      SELECT *
      FROM remote_worker_sessions
      WHERE session_id = $1
    `, [String(sessionId || '').trim()]);
  }

  async function touchRemoteWorkerSession(sessionId, client = pool) {
    await client.query(`
      UPDATE remote_worker_sessions
      SET last_seen_at = $1, liveness_state = 'online'
      WHERE session_id = $2
    `, [nowIso(), String(sessionId || '').trim()]);
  }

  async function listRemoteBacklogIndexerCandidates(input = {}, client = pool) {
    const limit = boundedInteger(input.limit, 25, 1, 100);
    const excluded = Array.isArray(input.excludeListingIds)
      ? input.excludeListingIds.map((value) => String(value || '').trim()).filter(Boolean)
      : [];
    return queryRows(client, `
      WITH active_claim_items AS (
        SELECT DISTINCT active_item.item->>'listingId' AS listing_id
        FROM remote_worker_claims c
        CROSS JOIN LATERAL jsonb_array_elements(
          COALESCE((NULLIF(c.payload_json, '')::jsonb)->'items', '[]'::jsonb)
        ) AS active_item(item)
        WHERE c.entity_type = 'listing_batch'
          AND c.status = ANY($1::text[])
          AND c.expires_at > $2
      )
      SELECT
        h.listing_id,
        h.href,
        h.source,
        h.source_keyword,
        h.card_title,
        h.card_text,
        h.detail_title,
        h.detail_price,
        h.detail_location,
        h.detail_condition,
        h.detail_listed_ago,
        h.detail_completed_at,
        h.detail_json,
        h.snapshot_path,
        h.first_seen_at,
        h.last_seen_at
      FROM homepage_listings h
      LEFT JOIN active_claim_items active ON active.listing_id = h.listing_id
      WHERE (h.detail_status = 'done' OR h.detail_completed_at IS NOT NULL OR NULLIF(h.snapshot_path, '') IS NOT NULL)
        AND LENGTH(TRIM(h.detail_listed_ago)) > 0
        AND (h.detail_listed_at_normalized_at = '' OR h.detail_listed_at_raw != h.detail_listed_ago)
        AND active.listing_id IS NULL
        AND NOT (h.listing_id = ANY($3::text[]))
      ORDER BY COALESCE(h.detail_completed_at, h.last_seen_at, h.first_seen_at) DESC, h.listing_id ASC
      LIMIT $4
    `, [['claimed', 'renewed'], nowIso(), excluded, limit]);
  }

  async function createBacklogIndexerClaim(session, items, input = {}, client = pool) {
    const now = nowIso();
    const leaseSeconds = boundedInteger(input.leaseSeconds, 180, 30, 3600);
    const expiresAt = input.expiresAt || new Date(Date.parse(now) + leaseSeconds * 1000).toISOString();
    const commandId = String(input.commandId || idFactory.commandId()).trim();
    const claimId = String(input.claimId || idFactory.claimId()).trim();
    const leaseId = String(input.leaseId || idFactory.leaseId()).trim();
    const payload = {
      indexerVersion: 'resolved-metadata-v1',
      items: items.map(remoteBacklogIndexerPayloadItem),
    };
    await client.query(`
      INSERT INTO remote_worker_commands (
        command_id,
        session_id,
        worker_id,
        worker_type,
        strategy,
        type,
        command_type,
        payload_json,
        priority,
        status,
        created_at,
        delivered_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'claimed', $10, $11)
    `, [
      commandId,
      session.session_id,
      session.worker_id,
      session.worker_type,
      session.strategy,
      'index_resolved_listing_metadata_batch',
      'index_resolved_listing_metadata_batch',
      safeJson(payload),
      0,
      now,
      now,
    ]);
    await client.query(`
      INSERT INTO remote_worker_claims (
        claim_id,
        lease_id,
        session_id,
        worker_id,
        command_id,
        command_type,
        entity_type,
        entity_id,
        payload_json,
        status,
        claimed_at,
        expires_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'claimed', $10, $11)
    `, [
      claimId,
      leaseId,
      session.session_id,
      session.worker_id,
      commandId,
      'index_resolved_listing_metadata_batch',
      'listing_batch',
      `listing-batch:${claimId}`,
      safeJson(payload),
      now,
      expiresAt,
    ]);
    return {
      leaseId,
      claimId,
      commandId,
      commandType: 'index_resolved_listing_metadata_batch',
      entityType: 'listing_batch',
      entityId: `listing-batch:${claimId}`,
      expiresAt,
      payload,
    };
  }

  async function claimRemoteWorkerWork(sessionId, body = {}) {
    const session = await getRemoteWorkerSession(sessionId);
    if (!session) {
      throw makeHttpError(`Unknown remote worker session: ${sessionId}`, 404, 'remote_worker_session_not_found');
    }
    const bodyWorkerId = String(body.workerId || '').trim();
    if (bodyWorkerId && bodyWorkerId !== session.worker_id) {
      throw makeHttpError('workerId does not match remote worker session.', 409, 'remote_worker_session_mismatch');
    }
    if (session.worker_type !== 'backlog_indexer' || session.strategy !== 'resolved_metadata') {
      await touchRemoteWorkerSession(session.session_id);
      return {
        claims: [],
        drainRequested: false,
        reason: 'unsupported_remote_claim_worker',
      };
    }
    if (!remoteBacklogIndexerAccepted(body)) {
      return {
        claims: [],
        drainRequested: false,
        reason: 'worker_does_not_accept_backlog_indexer_claims',
      };
    }

    const capacity = boundedInteger(body.capacity, 1, 1, 5);
    const batchSize = boundedInteger(body.batchSize || body.limit, 25, 1, 100);
    const claims = await withTransaction(async (client) => {
      const nextClaims = [];
      const excludeListingIds = [];
      for (let index = 0; index < capacity; index += 1) {
        const rows = await listRemoteBacklogIndexerCandidates({
          limit: batchSize,
          excludeListingIds,
        }, client);
        if (rows.length === 0) break;
        nextClaims.push(await createBacklogIndexerClaim(session, rows, {
          leaseSeconds: body.leaseSeconds,
        }, client));
        excludeListingIds.push(...rows.map((row) => row.listing_id));
      }
      await touchRemoteWorkerSession(session.session_id, client);
      return nextClaims;
    });
    return {
      claims,
      drainRequested: false,
      reason: claims.length > 0 ? '' : 'no_backlog_indexer_candidates',
    };
  }

  async function getLease(sessionId, leaseId, client = pool) {
    const session = await getRemoteWorkerSession(sessionId, client);
    if (!session) {
      throw makeHttpError(`Unknown remote worker session: ${sessionId}`, 404, 'remote_worker_session_not_found');
    }
    const lease = await queryOne(client, `
      SELECT *
      FROM remote_worker_claims
      WHERE lease_id = $1 AND session_id = $2
    `, [String(leaseId || '').trim(), session.session_id]);
    return { session, lease };
  }

  function assertRenewableLease(lease, message, code) {
    if (!['claimed', 'renewed'].includes(String(lease.status || '')) || Date.parse(lease.expires_at || '') <= Date.now()) {
      throw makeHttpError(message, 409, code);
    }
  }

  async function renewRemoteWorkerLease(sessionId, leaseId, body = {}) {
    const { lease } = await getLease(sessionId, leaseId);
    if (!lease) {
      return {
        status: 'unknown_lease',
        leaseId: String(leaseId || '').trim(),
        renewed: false,
      };
    }
    assertRenewableLease(lease, 'Remote worker lease is no longer renewable.', 'stale_remote_worker_lease');
    const now = nowIso();
    const expiresAt = body.expiresAt || new Date(Date.parse(now) + 3 * 60 * 1000).toISOString();
    await pool.query(`
      UPDATE remote_worker_claims
      SET status = 'renewed', renewed_at = $1, expires_at = $2
      WHERE claim_id = $3
    `, [now, expiresAt, lease.claim_id]);
    return {
      status: 'renewed',
      leaseId: lease.lease_id,
      claimId: lease.claim_id,
      expiresAt,
    };
  }

  async function completeRemoteWorkerLease(sessionId, leaseId, body = {}) {
    return withTransaction(async (client) => {
      const { lease } = await getLease(sessionId, leaseId, client);
      if (!lease) {
        return {
          status: 'unknown_lease',
          leaseId: String(leaseId || '').trim(),
          completed: false,
        };
      }
      assertRenewableLease(lease, 'Remote worker lease is stale and cannot be completed.', 'stale_remote_worker_lease');
      const now = nowIso();
      const requestedStatus = String(body.status || 'completed').trim();
      const status = requestedStatus === 'failed' ? 'failed' : 'completed';
      await client.query(`
        UPDATE remote_worker_claims
        SET status = $1, completed_at = $2, result_json = $3, last_error = $4
        WHERE claim_id = $5
      `, [status, now, safeJson(body.result || {}), String(body.error || '').trim(), lease.claim_id]);
      await client.query(`
        UPDATE remote_worker_commands
        SET status = $1, ack_status = $2, ack_payload_json = $3, acked_at = $4, last_error = $5
        WHERE command_id = $6
      `, [status, requestedStatus, safeJson(body.result || {}), now, String(body.error || '').trim(), lease.command_id]);
      return {
        status,
        leaseId: lease.lease_id,
        claimId: lease.claim_id,
        completed: true,
      };
    });
  }

  return {
    dialect: 'postgres',
    pool,
    getRemoteWorkerSession,
    listRemoteBacklogIndexerCandidates,
    createBacklogIndexerClaim,
    claimRemoteWorkerWork,
    renewRemoteWorkerLease,
    completeRemoteWorkerLease,
    async close() {
      if (typeof pool.end === 'function') await pool.end();
    },
  };
}

module.exports = {
  createRemoteWorkerPostgresStore,
  remoteBacklogIndexerPayloadItem,
  remoteBacklogIndexerAccepted,
};
