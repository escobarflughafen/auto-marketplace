const crypto = require('crypto');
const { validateRemoteEventEnvelope, validateArtifactManifest } = require('./remote-worker-contracts');
const { validateWorkerEvent } = require('./marketplace-worker-events');

function safeJson(value) {
  return JSON.stringify(value ?? {});
}

function normalizeKeyword(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function extractListingId(url) {
  const match = String(url || '').match(/\/marketplace\/item\/(\d+)/);
  return match ? match[1] : '';
}

function extractGoofishListingId(url) {
  const text = String(url || '');
  const match = text.match(/[?&]id=(\d{9,})/i)
    || text.match(/[?&]itemId=(\d{9,})/i)
    || text.match(/[?&]item_id=(\d{9,})/i)
    || text.match(/\/item\/(\d{9,})/i);
  return match ? match[1] : '';
}

function canonicalizeListingUrl(url) {
  const listingId = extractListingId(url);
  if (listingId) {
    return `https://www.facebook.com/marketplace/item/${listingId}/`;
  }
  try {
    const parsed = new URL(String(url || ''));
    if (/goofish\.com$/i.test(parsed.hostname) && parsed.pathname === '/item') {
      const goofishListingId = extractGoofishListingId(parsed.toString());
      if (goofishListingId) {
        const categoryId = parsed.searchParams.get('categoryId') || '';
        return `https://www.goofish.com/item?id=${goofishListingId}${categoryId ? `&categoryId=${encodeURIComponent(categoryId)}` : ''}`;
      }
    }
    return `${parsed.origin}${parsed.pathname}`;
  } catch {
    return String(url || '').trim();
  }
}

function normalizeListingMediaItems(items = []) {
  return (Array.isArray(items) ? items : [])
    .map((item, index) => {
      const sourceUrl = String(item.sourceUrl || item.source_url || item.src || item.url || '').trim();
      const artifactPath = String(item.artifactPath || item.artifact_path || item.screenshotPath || item.screenshot_path || '').trim();
      if (!sourceUrl && !artifactPath) return null;
      const mediaKey = String(item.mediaKey || item.media_key || '').trim()
        || crypto.createHash('sha1').update(`${sourceUrl}\n${artifactPath}`).digest('hex');
      return {
        mediaKey,
        mediaType: String(item.mediaType || item.media_type || 'image').trim() || 'image',
        source: String(item.source || '').trim(),
        sourceUrl,
        artifactPath,
        altText: String(item.altText || item.alt_text || item.alt || '').trim(),
        width: Number.isFinite(Number(item.width)) ? Number(item.width) : null,
        height: Number.isFinite(Number(item.height)) ? Number(item.height) : null,
        position: Number.isFinite(Number(item.position)) ? Number(item.position) : index,
        metadata: item.metadata || item.metadata_json || {},
      };
    })
    .filter(Boolean);
}

function parseListingDetailJson(row) {
  try {
    const parsed = JSON.parse(row?.detail_json || '{}');
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function hashJson(value) {
  return crypto.createHash('sha256').update(safeJson(value)).digest('hex');
}

function normalizeRemoteEventForSession(session, event) {
  const payload = event.payload && typeof event.payload === 'object' ? event.payload : {};
  return validateRemoteEventEnvelope({
    ...event,
    sessionId: session.session_id,
    workerId: session.worker_id,
    workerType: event.workerType || event.worker_type || session.worker_type,
    strategy: event.strategy || session.strategy,
    payload,
  });
}

function validateRemoteWorkerRegistryEvent(session, remoteEvent) {
  const payload = {
    ...remoteEvent.payload,
    workerType: remoteEvent.payload.workerType || session.worker_type,
    strategy: remoteEvent.payload.strategy || session.strategy,
  };
  if (remoteEvent.listingId && payload.listingId === undefined) {
    payload.listingId = remoteEvent.listingId;
  }
  validateWorkerEvent({
    eventType: remoteEvent.eventType,
    workerType: remoteEvent.workerType || session.worker_type,
    strategy: remoteEvent.strategy || session.strategy,
    payload,
  });
  return payload;
}

function normalizeArtifactManifestForSession(session, manifest) {
  return validateArtifactManifest({
    ...manifest,
    workerId: manifest.workerId || session.worker_id,
    sessionId: manifest.sessionId || session.session_id,
  }, {
    maxArtifactBytes: 5 * 1024 * 1024,
  });
}

function isoToUnixSeconds(value) {
  const parsed = Date.parse(String(value || ''));
  return Number.isFinite(parsed) ? Math.floor(parsed / 1000) : null;
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

function buildRemoteSessionId() {
  return randomId('remote-session');
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
    sessionId: options.idFactory?.sessionId || buildRemoteSessionId,
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

  async function insertRemoteWorkflowRun(session, now, client = pool) {
    await client.query(`
      INSERT INTO workflow_runs (
        run_id,
        workflow_id,
        label,
        script,
        args_json,
        pid,
        status,
        started_at,
        updated_at,
        os_alive,
        logs_json
      ) VALUES ($1, $2, $3, 'remote-worker', '[]', NULL, 'running', $4, $5, 1, '[]')
    `, [
      session.session_id,
      `remote-${session.worker_type}`,
      `Remote ${session.worker_type}`,
      now,
      now,
    ]);
  }

  async function registerRemoteWorkerSession(body = {}) {
    const now = nowIso();
    const sessionId = String(body.sessionId || body.session_id || idFactory.sessionId()).trim();
    const workerId = String(body.workerId || '').trim();
    const workerType = String(body.workerType || '').trim();
    const strategy = String(body.strategy || '').trim();
    if (!workerId || !workerType) {
      throw makeHttpError('workerId and workerType are required.', 400, 'invalid_remote_worker_session');
    }
    const lastLocalSequence = Number(body.lastCheckpoint?.lastLocalSequence || 0);
    const lastAckedSequence = Number(body.lastCheckpoint?.lastAckedSequence || 0);
    await withTransaction(async (client) => {
      const session = {
        session_id: sessionId,
        worker_id: workerId,
        worker_type: workerType,
        strategy,
      };
      await client.query(`
        INSERT INTO remote_worker_sessions (
          session_id,
          worker_id,
          worker_type,
          strategy,
          worker_version,
          source_id,
          capabilities_json,
          status,
          liveness_state,
          last_local_sequence,
          last_acked_sequence,
          pending_event_count,
          registered_at,
          last_seen_at,
          updated_at
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, 'registered', 'online', $8, $9, 0, $10, $11, $12)
      `, [
        sessionId,
        workerId,
        workerType,
        strategy,
        String(body.workerVersion || '').trim(),
        String(body.sourceId || '').trim(),
        safeJson(body.capabilities || {}),
        lastLocalSequence,
        lastAckedSequence,
        now,
        now,
        now,
      ]);
      await insertRemoteWorkflowRun(session, now, client);
    });
    return {
      sessionId,
      status: 'registered',
      hostCheckpoint: {
        lastAcceptedSequence: lastAckedSequence,
      },
    };
  }

  async function updateRemoteWorkerHeartbeat(sessionId, body = {}) {
    const session = await getRemoteWorkerSession(sessionId);
    if (!session) {
      throw makeHttpError(`Unknown remote worker session: ${sessionId}`, 404, 'remote_worker_session_not_found');
    }
    if (String(body.workerId || '').trim() !== session.worker_id) {
      throw makeHttpError('workerId does not match remote worker session.', 409, 'remote_worker_session_mismatch');
    }
    const now = nowIso();
    await withTransaction(async (client) => {
      await client.query(`
        UPDATE remote_worker_sessions
        SET
          runtime_state = $1,
          liveness_state = 'online',
          last_local_sequence = $2,
          pending_event_count = $3,
          last_seen_at = $4,
          updated_at = $5
        WHERE session_id = $6
      `, [
        String(body.runtimeState || '').trim(),
        Number(body.lastLocalSequence || 0),
        Number(body.pendingEventCount || 0),
        now,
        now,
        session.session_id,
      ]);
      await client.query(`
        UPDATE workflow_runs
        SET status = 'running', updated_at = $1, os_alive = 1
        WHERE run_id = $2
      `, [now, session.session_id]);
    });
    const updated = await getRemoteWorkerSession(sessionId);
    return {
      status: 'ok',
      hostCheckpoint: {
        lastAcceptedSequence: Number(updated?.last_acked_sequence || 0),
      },
    };
  }

  async function touchRemoteWorkerSession(sessionId, client = pool) {
    await client.query(`
      UPDATE remote_worker_sessions
      SET last_seen_at = $1, liveness_state = 'online'
      WHERE session_id = $2
    `, [nowIso(), String(sessionId || '').trim()]);
  }

  async function createRemoteWorkerCommand(command = {}, client = pool) {
    const commandType = String(command.commandType || command.command_type || command.type || '').trim();
    if (!commandType) {
      throw new Error('remote worker command requires commandType');
    }
    const now = command.createdAt || nowIso();
    const commandId = String(command.commandId || command.command_id || idFactory.commandId()).trim();
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
        created_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'queued', $10)
    `, [
      commandId,
      String(command.sessionId || command.session_id || '').trim(),
      String(command.workerId || command.worker_id || '').trim(),
      String(command.workerType || command.worker_type || '').trim(),
      String(command.strategy || '').trim(),
      commandType,
      commandType,
      safeJson(command.payload || {}),
      Number.isFinite(Number(command.priority)) ? Number(command.priority) : 0,
      now,
    ]);
    return commandId;
  }

  async function listRemoteWorkerCommands(sessionId, input = {}) {
    const session = await getRemoteWorkerSession(sessionId);
    if (!session) {
      throw makeHttpError(`Unknown remote worker session: ${sessionId}`, 404, 'remote_worker_session_not_found');
    }
    const limit = boundedInteger(input.limit, 25, 1, 100);
    const now = nowIso();
    const rows = await queryRows(pool, `
      SELECT *
      FROM remote_worker_commands
      WHERE status = 'queued'
        AND (session_id = '' OR session_id = $1)
        AND (worker_id = '' OR worker_id = $2)
        AND (worker_type = '' OR worker_type = $3)
        AND (strategy = '' OR strategy = $4)
      ORDER BY priority DESC, created_at ASC
      LIMIT $5
    `, [session.session_id, session.worker_id, session.worker_type, session.strategy, limit]);
    if (rows.length > 0) {
      await withTransaction(async (client) => {
        for (const row of rows) {
          await client.query(`
            UPDATE remote_worker_commands
            SET delivered_at = CASE WHEN delivered_at = '' THEN $1 ELSE delivered_at END
            WHERE command_id = $2
          `, [now, row.command_id]);
        }
        await touchRemoteWorkerSession(session.session_id, client);
      });
    }
    return {
      commands: rows.map((row) => ({
        commandId: row.command_id,
        commandType: row.command_type,
        payload: parseListingDetailJson({ detail_json: row.payload_json }),
        priority: Number(row.priority) || 0,
        createdAt: row.created_at,
        deliveredAt: row.delivered_at || now,
      })),
    };
  }

  async function insertRemoteWorkerIngestRow(session, batchId, remoteEvent, payload, reduceStatus = 'reduced', client = pool) {
    const now = nowIso();
    await client.query(`
      INSERT INTO remote_worker_event_ingest (
        event_id,
        session_id,
        worker_id,
        worker_type,
        strategy,
        batch_id,
        sequence,
        event_scope,
        event_type,
        event_at,
        listing_id,
        status,
        canonical_hash,
        payload_json,
        payload_hash,
        reduce_status,
        received_at,
        reduced_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18)
    `, [
      remoteEvent.eventId,
      session.session_id,
      session.worker_id,
      remoteEvent.workerType || session.worker_type,
      remoteEvent.strategy || session.strategy,
      String(batchId || '').trim(),
      remoteEvent.sequence,
      remoteEvent.eventScope,
      remoteEvent.eventType,
      remoteEvent.eventAt,
      remoteEvent.listingId,
      remoteEvent.status,
      hashJson(payload),
      safeJson(payload),
      hashJson(payload),
      reduceStatus,
      now,
      now,
    ]);
  }

  async function appendWorkflowEvent(session, remoteEvent, payload, client = pool) {
    await client.query(`
      INSERT INTO workflow_events (
        event_id,
        workflow_run_id,
        event_type,
        event_at,
        status,
        content_json,
        error
      ) VALUES ($1, $2, $3, $4, $5, $6, $7)
    `, [
      remoteEvent.eventId,
      session.session_id,
      remoteEvent.eventType,
      remoteEvent.eventAt,
      remoteEvent.status,
      safeJson(payload),
      String(payload.errorMessage || payload.reason || '').trim(),
    ]);
  }

  async function appendListingEvent(session, remoteEvent, payload, client = pool) {
    await client.query(`
      INSERT INTO listing_events (
        event_id,
        workflow_run_id,
        listing_id,
        event_type,
        event_at,
        worker_id,
        status,
        content_json,
        error
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
    `, [
      remoteEvent.eventId,
      session.session_id,
      remoteEvent.listingId,
      remoteEvent.eventType,
      remoteEvent.eventAt,
      session.worker_id,
      remoteEvent.status,
      safeJson(payload),
      String(payload.errorMessage || payload.reason || '').trim(),
    ]);
  }

  async function upsertObservedHomepageListing(remoteEvent, payload, source, sourceKeyword, seenAt, client = pool) {
    const href = canonicalizeListingUrl(payload.href || remoteEvent.sourceUrl || '');
    const listingId = String(remoteEvent.listingId || payload.listingId || extractListingId(href) || href).trim();
    if (!listingId) return '';
    const rank = Number.isFinite(Number(payload.rank)) ? Number(payload.rank) : null;
    const cardTitle = String(payload.cardTitle || payload.title || '').trim();
    const cardText = String(payload.cardText || payload.text || '').trim();
    const cardPrice = String(payload.price || payload.cardPrice || payload.detailPrice || payload.detail_price || '').trim();
    const rawCardJson = safeJson({
      ...payload,
      href,
      listingId,
      rank,
      source,
      sourceKeyword,
    });
    await client.query(`
      INSERT INTO homepage_listings (
        listing_id,
        href,
        source,
        source_keyword,
        card_title,
        card_text,
        raw_card_json,
        first_seen_at,
        last_seen_at,
        last_seen_rank,
        detail_status,
        detail_price,
        detail_last_error
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'pending', $11, '')
      ON CONFLICT(listing_id) DO UPDATE SET
        href = EXCLUDED.href,
        source = EXCLUDED.source,
        source_keyword = EXCLUDED.source_keyword,
        card_title = EXCLUDED.card_title,
        card_text = EXCLUDED.card_text,
        raw_card_json = EXCLUDED.raw_card_json,
        last_seen_at = EXCLUDED.last_seen_at,
        last_seen_rank = EXCLUDED.last_seen_rank,
        detail_price = CASE
          WHEN EXCLUDED.detail_price = ''
            THEN homepage_listings.detail_price
          WHEN homepage_listings.detail_status IN ('done', 'processing', 'sold', 'pending_sale')
            AND homepage_listings.detail_price <> ''
            THEN homepage_listings.detail_price
          ELSE EXCLUDED.detail_price
        END,
        detail_status = CASE
          WHEN homepage_listings.detail_status IN ('done', 'processing', 'sold', 'pending_sale')
            THEN homepage_listings.detail_status
          ELSE 'pending'
        END,
        detail_last_error = CASE
          WHEN homepage_listings.detail_status IN ('done', 'processing', 'sold', 'pending_sale')
            THEN homepage_listings.detail_last_error
          ELSE ''
        END
    `, [
      listingId,
      href,
      source,
      sourceKeyword,
      cardTitle,
      cardText,
      rawCardJson,
      seenAt,
      seenAt,
      rank,
      cardPrice,
    ]);
    return listingId;
  }

  async function upsertObservedListingMedia(listingId, items = [], source, seenAt, client = pool) {
    const normalizedListingId = String(listingId || '').trim();
    const mediaItems = normalizeListingMediaItems(items);
    if (!normalizedListingId || mediaItems.length === 0) return;
    for (const item of mediaItems) {
      await client.query(`
        INSERT INTO listing_media (
          listing_id,
          media_key,
          media_type,
          source,
          source_url,
          artifact_path,
          alt_text,
          width,
          height,
          position,
          first_seen_at,
          last_seen_at,
          metadata_json
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
        ON CONFLICT(listing_id, media_key) DO UPDATE SET
          media_type = EXCLUDED.media_type,
          source = EXCLUDED.source,
          source_url = EXCLUDED.source_url,
          artifact_path = EXCLUDED.artifact_path,
          alt_text = EXCLUDED.alt_text,
          width = EXCLUDED.width,
          height = EXCLUDED.height,
          position = EXCLUDED.position,
          last_seen_at = EXCLUDED.last_seen_at,
          metadata_json = EXCLUDED.metadata_json
      `, [
        normalizedListingId,
        item.mediaKey,
        item.mediaType,
        item.source || source,
        item.sourceUrl,
        item.artifactPath,
        item.altText,
        item.width,
        item.height,
        item.position,
        seenAt,
        seenAt,
        safeJson(item.metadata || {}),
      ]);
    }
  }

  async function upsertListingSearchKeyword(listingId, keyword, seenAt, client = pool) {
    const normalizedListingId = String(listingId || '').trim();
    const normalizedKeyword = normalizeKeyword(keyword).toLowerCase();
    if (!normalizedListingId || !normalizedKeyword) return;
    const canonicalKeyword = normalizeKeyword(keyword);
    await client.query(`
      INSERT INTO listing_search_keywords (
        listing_id,
        normalized_keyword,
        keyword,
        first_seen_at,
        last_seen_at,
        times_seen
      ) VALUES ($1, $2, $3, $4, $5, 1)
      ON CONFLICT(listing_id, normalized_keyword) DO UPDATE SET
        keyword = EXCLUDED.keyword,
        last_seen_at = EXCLUDED.last_seen_at,
        times_seen = listing_search_keywords.times_seen + 1
    `, [normalizedListingId, normalizedKeyword, canonicalKeyword, seenAt, seenAt]);
  }

  async function upsertSearchTitleBagKeyword(keyword, sourceKeyword, seenAt, client = pool) {
    const normalizedKeyword = normalizeKeyword(keyword).toLowerCase();
    if (!normalizedKeyword) return;
    await client.query(`
      INSERT INTO search_title_bag (
        normalized_keyword,
        keyword,
        first_seen_at,
        last_seen_at,
        times_seen,
        last_source_keyword
      ) VALUES ($1, $2, $3, $4, 1, $5)
      ON CONFLICT(normalized_keyword) DO UPDATE SET
        keyword = EXCLUDED.keyword,
        last_seen_at = EXCLUDED.last_seen_at,
        times_seen = search_title_bag.times_seen + 1,
        last_source_keyword = EXCLUDED.last_source_keyword
    `, [
      normalizedKeyword,
      normalizeKeyword(keyword),
      seenAt,
      seenAt,
      normalizeKeyword(sourceKeyword || ''),
    ]);
  }

  async function reduceCollectorListingObservedEvent(session, remoteEvent, payload, client = pool) {
    if (remoteEvent.eventType !== 'listing_observed' || !remoteEvent.listingId) return;
    const eventStrategy = String(remoteEvent.strategy || session.strategy || '').trim();
    const source = String(payload.source || '').trim() || (eventStrategy === 'explorer' ? 'search' : 'homepage');
    const sourceKeyword = String(payload.sourceKeyword || payload.source_keyword || '').trim();
    const seenAt = remoteEvent.eventAt || nowIso();
    const listingId = await upsertObservedHomepageListing(remoteEvent, payload, source, sourceKeyword, seenAt, client);
    await upsertObservedListingMedia(
      listingId,
      Array.isArray(payload.photos) ? payload.photos : Array.isArray(payload.media) ? payload.media : [],
      source,
      seenAt,
      client,
    );
    if (source === 'search' && sourceKeyword) {
      await upsertListingSearchKeyword(listingId, sourceKeyword, seenAt, client);
      if (payload.cardTitle || payload.title) {
        await upsertSearchTitleBagKeyword(payload.cardTitle || payload.title, sourceKeyword, seenAt, client);
      }
      await upsertSearchTitleBagKeyword(sourceKeyword, sourceKeyword, seenAt, client);
    }
  }

  async function reduceBacklogListingMetadataEvent(session, remoteEvent, payload, client = pool) {
    if (remoteEvent.eventType !== 'backlog_listing_metadata_indexed' || !remoteEvent.listingId) return;
    const earliestUnix = Number.isFinite(Number(payload.listedAtEarliestUnix))
      ? Number(payload.listedAtEarliestUnix)
      : isoToUnixSeconds(payload.listedAtMin || payload.listedAtEarliest || payload.listedAtEarliestIso);
    const latestUnix = Number.isFinite(Number(payload.listedAtLatestUnix))
      ? Number(payload.listedAtLatestUnix)
      : isoToUnixSeconds(payload.listedAtMax || payload.listedAtLatest || payload.listedAtLatestIso);
    const anchorUnix = Number.isFinite(Number(payload.listedAtAnchorUnix))
      ? Number(payload.listedAtAnchorUnix)
      : isoToUnixSeconds(payload.resolvedAt || payload.anchorAt || remoteEvent.eventAt);
    await client.query(`
      UPDATE homepage_listings
      SET
        detail_listed_at_raw = COALESCE(NULLIF($1, ''), detail_listed_ago),
        detail_listed_at_earliest_unix = $2,
        detail_listed_at_latest_unix = $3,
        detail_listed_at_anchor_unix = $4,
        detail_listed_at_language = $5,
        detail_listed_at_unit = $6,
        detail_listed_at_value = $7,
        detail_listed_at_confidence = $8,
        detail_listed_at_source = $9,
        detail_listed_at_normalized_at = $10
      WHERE listing_id = $11
    `, [
      String(payload.detailListedAgo || payload.listedAgo || '').trim(),
      earliestUnix,
      latestUnix,
      anchorUnix,
      String(payload.language || '').trim(),
      String(payload.unit || '').trim(),
      Number.isFinite(Number(payload.value)) ? Number(payload.value) : null,
      String(payload.confidence || '').trim(),
      `remote:${session.worker_id}:${payload.indexerVersion || 'backlog-indexer'}`,
      remoteEvent.eventAt || nowIso(),
      remoteEvent.listingId,
    ]);
  }

  async function projectRemoteWorkerEvent(session, remoteEvent, payload, client = pool) {
    if (remoteEvent.eventScope === 'workflow') {
      await appendWorkflowEvent(session, remoteEvent, payload, client);
      return;
    }
    if (remoteEvent.eventScope === 'listing') {
      await reduceCollectorListingObservedEvent(session, remoteEvent, payload, client);
      await appendListingEvent(session, remoteEvent, payload, client);
      await reduceBacklogListingMetadataEvent(session, remoteEvent, payload, client);
      return;
    }
    const error = new Error(`Unsupported remote event scope: ${remoteEvent.eventScope}`);
    error.code = 'unsupported_remote_event_scope';
    throw error;
  }

  async function ingestRemoteWorkerEvents(sessionId, body = {}) {
    const session = await getRemoteWorkerSession(sessionId);
    if (!session) {
      throw makeHttpError(`Unknown remote worker session: ${sessionId}`, 404, 'remote_worker_session_not_found');
    }
    if (String(body.workerId || '').trim() !== session.worker_id) {
      throw makeHttpError('workerId does not match remote worker session.', 409, 'remote_worker_session_mismatch');
    }
    const accepted = [];
    const duplicates = [];
    const rejected = [];
    const events = Array.isArray(body.events) ? body.events : [];
    for (const event of events) {
      const eventId = String(event.eventId || event.event_id || '').trim();
      if (!eventId) {
        rejected.push({ eventId: '', error: 'eventId is required' });
        continue;
      }
      const existing = await queryOne(pool, `
        SELECT event_id, sequence
        FROM remote_worker_event_ingest
        WHERE event_id = $1
      `, [eventId]);
      if (existing) {
        duplicates.push({ eventId, sequence: Number(existing.sequence) || 0 });
        continue;
      }
      try {
        await withTransaction(async (client) => {
          const remoteEvent = normalizeRemoteEventForSession(session, event);
          const payload = validateRemoteWorkerRegistryEvent(session, remoteEvent);
          await insertRemoteWorkerIngestRow(session, body.batchId, remoteEvent, payload, 'reduced', client);
          await projectRemoteWorkerEvent(session, remoteEvent, payload, client);
          accepted.push({ eventId: remoteEvent.eventId, sequence: remoteEvent.sequence });
        });
      } catch (error) {
        rejected.push({ eventId, error: error.message });
      }
    }
    if (rejected.length > 0) {
      const error = makeHttpError(rejected[0].error || 'Invalid remote worker event batch.', 400, 'invalid_event_batch');
      error.rejected = rejected;
      throw error;
    }
    const checkpoint = await queryOne(pool, `
      SELECT COALESCE(MAX(sequence), 0) AS "lastAcceptedSequence"
      FROM remote_worker_event_ingest
      WHERE session_id = $1
    `, [session.session_id]);
    const lastAcceptedSequence = Number(checkpoint?.lastAcceptedSequence || checkpoint?.lastacceptedsequence || 0);
    const now = nowIso();
    await pool.query(`
      UPDATE remote_worker_sessions
      SET
        last_acked_sequence = $1,
        last_seen_at = $2,
        liveness_state = 'online'
      WHERE session_id = $3
    `, [lastAcceptedSequence, now, session.session_id]);
    return {
      status: 'accepted',
      accepted,
      duplicates,
      rejected: [],
      checkpoint: {
        lastAcceptedSequence,
      },
    };
  }

  async function listRemoteWorkerIngestEvents(sessionId) {
    const rows = await queryRows(pool, `
      SELECT *
      FROM remote_worker_event_ingest
      WHERE session_id = $1
      ORDER BY sequence ASC
    `, [String(sessionId || '').trim()]);
    return rows.map((row) => ({
      eventId: row.event_id,
      sessionId: row.session_id,
      workerId: row.worker_id,
      workerType: row.worker_type,
      strategy: row.strategy,
      sequence: Number(row.sequence) || 0,
      eventScope: row.event_scope,
      eventType: row.event_type,
      eventAt: row.event_at,
      listingId: row.listing_id,
      status: row.status,
      payload: parseListingDetailJson({ detail_json: row.payload_json }),
      reduceStatus: row.reduce_status,
      reduceError: row.reduce_error,
    }));
  }

  async function ingestRemoteWorkerArtifacts(sessionId, body = {}) {
    const session = await getRemoteWorkerSession(sessionId);
    if (!session) {
      throw makeHttpError(`Unknown remote worker session: ${sessionId}`, 404, 'remote_worker_session_not_found');
    }
    const bodyWorkerId = String(body.workerId || '').trim();
    if (bodyWorkerId && bodyWorkerId !== session.worker_id) {
      throw makeHttpError('workerId does not match remote worker session.', 409, 'remote_worker_session_mismatch');
    }
    const artifacts = Array.isArray(body.artifacts)
      ? body.artifacts
      : (body.artifactId ? [body] : []);
    const accepted = [];
    const duplicates = [];
    const rejected = [];
    const now = nowIso();
    for (const artifact of artifacts) {
      const artifactId = String(artifact.artifactId || '').trim();
      if (!artifactId) {
        rejected.push({ artifactId: '', error: 'artifactId is required' });
        continue;
      }
      try {
        const manifest = normalizeArtifactManifestForSession(session, artifact);
        const existing = await queryOne(pool, `
          SELECT artifact_id, sha256, size_bytes
          FROM remote_worker_artifacts
          WHERE artifact_id = $1
        `, [manifest.artifactId]);
        if (existing) {
          if (existing.sha256 !== manifest.sha256 || Number(existing.size_bytes) !== Number(manifest.sizeBytes)) {
            rejected.push({
              artifactId: manifest.artifactId,
              error: 'artifactId already exists with different content hash or size',
            });
          } else {
            duplicates.push({ artifactId: manifest.artifactId, sha256: manifest.sha256 });
          }
          continue;
        }
        await pool.query(`
          INSERT INTO remote_worker_artifacts (
            artifact_id,
            session_id,
            worker_id,
            event_id,
            kind,
            artifact_type,
            media_role,
            content_type,
            sha256,
            size_bytes,
            width,
            height,
            path,
            source_url,
            local_path,
            storage_json,
            metadata_json,
            derivatives_json,
            upload_status,
            created_at,
            accepted_at,
            received_at,
            updated_at
          ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, 'manifest_accepted', $19, $20, $21, $22)
        `, [
          manifest.artifactId,
          session.session_id,
          session.worker_id,
          String(manifest.eventId || '').trim(),
          String(manifest.artifactType || '').trim(),
          String(manifest.artifactType || '').trim(),
          String(manifest.mediaRole || '').trim(),
          String(manifest.contentType || '').trim(),
          manifest.sha256,
          Number(manifest.sizeBytes || 0),
          Number.isFinite(Number(manifest.width)) ? Number(manifest.width) : null,
          Number.isFinite(Number(manifest.height)) ? Number(manifest.height) : null,
          String(manifest.localPath || '').trim(),
          String(manifest.sourceUrl || '').trim(),
          String(manifest.localPath || '').trim(),
          safeJson(manifest.storage || {}),
          safeJson(manifest.metadata || {}),
          safeJson(manifest.derivatives || []),
          now,
          now,
          now,
          now,
        ]);
        accepted.push({ artifactId: manifest.artifactId, sha256: manifest.sha256, uploadStatus: 'manifest_accepted' });
      } catch (error) {
        rejected.push({ artifactId, error: error.message });
      }
    }
    if (rejected.length > 0) {
      const error = makeHttpError(rejected[0].error || 'Invalid remote worker artifact manifest.', 400, 'invalid_artifact_batch');
      error.rejected = rejected;
      throw error;
    }
    await touchRemoteWorkerSession(session.session_id);
    return {
      status: 'accepted',
      accepted,
      duplicates,
      rejected: [],
    };
  }

  async function ackRemoteWorkerCommand(sessionId, commandId, body = {}) {
    const session = await getRemoteWorkerSession(sessionId);
    if (!session) {
      throw makeHttpError(`Unknown remote worker session: ${sessionId}`, 404, 'remote_worker_session_not_found');
    }
    const command = await queryOne(pool, `
      SELECT *
      FROM remote_worker_commands
      WHERE command_id = $1
    `, [String(commandId || '').trim()]);
    if (!command) {
      throw makeHttpError(`Unknown remote worker command: ${commandId}`, 404, 'remote_worker_command_not_found');
    }
    const matchesSession = !command.session_id || command.session_id === session.session_id;
    const matchesWorker = !command.worker_id || command.worker_id === session.worker_id;
    if (!matchesSession || !matchesWorker) {
      throw makeHttpError('Command does not belong to this remote worker session.', 409, 'remote_worker_command_mismatch');
    }
    const ackStatus = String(body.status || body.ackStatus || 'acked').trim();
    const terminalStatus = ackStatus === 'failed' ? 'failed' : 'acked';
    const now = nowIso();
    await pool.query(`
      UPDATE remote_worker_commands
      SET
        status = $1,
        ack_status = $2,
        ack_payload_json = $3,
        acked_at = $4,
        last_error = $5
      WHERE command_id = $6
    `, [
      terminalStatus,
      ackStatus,
      safeJson(body.payload || {}),
      now,
      String(body.error || '').trim(),
      command.command_id,
    ]);
    return {
      status: terminalStatus,
      commandId: command.command_id,
      ackStatus,
    };
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
    registerRemoteWorkerSession,
    updateRemoteWorkerHeartbeat,
    createRemoteWorkerCommand,
    listRemoteWorkerCommands,
    ackRemoteWorkerCommand,
    ingestRemoteWorkerEvents,
    listRemoteWorkerIngestEvents,
    ingestRemoteWorkerArtifacts,
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
