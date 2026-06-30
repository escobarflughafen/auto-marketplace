const test = require('node:test');
const assert = require('node:assert/strict');

const {
  createMarketplaceConfigPostgresStore,
  normalizeSummaryQueryCardRow,
  normalizeSavedQueryRow,
} = require('../scripts/marketplace-config-postgres-store');

function createFakePool(initialState = {}) {
  const calls = [];
  const state = {
    summaryCards: new Map((initialState.summaryCards || []).map((row) => [row.card_id, { ...row }])),
    savedQueries: new Map((initialState.savedQueries || []).map((row) => [row.query_id, { ...row }])),
  };
  return {
    calls,
    state,
    ended: false,
    async query(sql, params = []) {
      calls.push({ sql, params });

      if (/^\s*SELECT[\s\S]*FROM summary_query_cards/.test(sql) && /WHERE card_id = \$1/.test(sql)) {
        return { rows: state.summaryCards.has(params[0]) ? [{ ...state.summaryCards.get(params[0]) }] : [] };
      }
      if (/^\s*SELECT[\s\S]*FROM summary_query_cards/.test(sql)) {
        const rows = [...state.summaryCards.values()].sort((left, right) => (
          Number(left.position) - Number(right.position)
          || String(right.updated_at).localeCompare(String(left.updated_at))
          || String(left.label).localeCompare(String(right.label))
        ));
        return { rows: rows.map((row) => ({ ...row })) };
      }
      if (/INSERT INTO summary_query_cards/.test(sql)) {
        const [cardId, label, query, position, createdAt, updatedAt] = params;
        const previous = state.summaryCards.get(cardId) || {};
        state.summaryCards.set(cardId, {
          ...previous,
          card_id: cardId,
          label,
          query,
          position,
          created_at: previous.created_at || createdAt,
          updated_at: updatedAt,
        });
        return { rows: [] };
      }
      if (/DELETE FROM summary_query_cards/.test(sql)) {
        state.summaryCards.delete(params[0]);
        return { rows: [] };
      }

      if (/^\s*SELECT[\s\S]*FROM saved_queries/.test(sql) && /WHERE query_id = \$1/.test(sql)) {
        return { rows: state.savedQueries.has(params[0]) ? [{ ...state.savedQueries.get(params[0]) }] : [] };
      }
      if (/^\s*SELECT[\s\S]*FROM saved_queries/.test(sql)) {
        const rows = [...state.savedQueries.values()].sort((left, right) => (
          String(right.updated_at).localeCompare(String(left.updated_at))
          || String(left.label).localeCompare(String(right.label))
        ));
        return { rows: rows.map((row) => ({ ...row })) };
      }
      if (/INSERT INTO saved_queries/.test(sql)) {
        const [queryId, label, query, showInOverview, createdAt, updatedAt] = params;
        const previous = state.savedQueries.get(queryId) || {};
        state.savedQueries.set(queryId, {
          ...previous,
          query_id: queryId,
          label,
          query,
          show_in_overview: showInOverview,
          created_at: previous.created_at || createdAt,
          updated_at: updatedAt,
        });
        return { rows: [] };
      }
      if (/UPDATE saved_queries/.test(sql)) {
        const [showInOverview, updatedAt, queryId] = params;
        const previous = state.savedQueries.get(queryId);
        if (previous) {
          state.savedQueries.set(queryId, {
            ...previous,
            show_in_overview: showInOverview,
            updated_at: updatedAt,
          });
        }
        return { rows: [] };
      }
      if (/DELETE FROM saved_queries/.test(sql)) {
        state.savedQueries.delete(params[0]);
        return { rows: [] };
      }

      return { rows: [] };
    },
    async end() {
      this.ended = true;
    },
  };
}

test('normalizes PostgreSQL config rows to existing SQLite helper shapes', () => {
  assert.deepEqual(normalizeSummaryQueryCardRow({
    card_id: 'card-1',
    label: 'Camera',
    query: 'price:>100',
    position: '2',
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-02T00:00:00.000Z',
  }), {
    card_id: 'card-1',
    label: 'Camera',
    query: 'price:>100',
    position: 2,
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-02T00:00:00.000Z',
  });

  assert.deepEqual(normalizeSavedQueryRow({
    query_id: 'saved-1',
    label: 'Saved',
    query: 'status:done',
    show_in_overview: '1',
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-02T00:00:00.000Z',
  }), {
    id: 'saved-1',
    query_id: 'saved-1',
    label: 'Saved',
    query: 'status:done',
    showInOverview: true,
    show_in_overview: true,
    source: 'server',
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-02T00:00:00.000Z',
  });
});

test('summary query cards preserve created_at and use PostgreSQL placeholders', async () => {
  const pool = createFakePool({
    summaryCards: [{
      card_id: 'summary-camera',
      label: 'Camera',
      query: 'status:done',
      position: 5,
      created_at: '2026-01-01T00:00:00.000Z',
      updated_at: '2026-01-02T00:00:00.000Z',
    }],
  });
  const store = createMarketplaceConfigPostgresStore({
    pool,
    nowIso: () => '2026-01-03T00:00:00.000Z',
  });

  const card = await store.upsertSummaryQueryCard({
    cardId: 'summary-camera',
    label: ' Camera ',
    query: ' price:>500 ',
  });

  assert.equal(card.card_id, 'summary-camera');
  assert.equal(card.query, 'price:>500');
  assert.equal(card.position, 5);
  assert.equal(card.created_at, '2026-01-01T00:00:00.000Z');
  assert.equal(card.updated_at, '2026-01-03T00:00:00.000Z');
  const insert = pool.calls.find((call) => /INSERT INTO summary_query_cards/.test(call.sql));
  assert.ok(insert);
  assert.match(insert.sql, /\$1/);
  assert.deepEqual(insert.params, [
    'summary-camera',
    'Camera',
    'price:>500',
    5,
    '2026-01-01T00:00:00.000Z',
    '2026-01-03T00:00:00.000Z',
  ]);

  const rows = await store.listSummaryQueryCards();
  assert.equal(rows.length, 1);
  const deleted = await store.deleteSummaryQueryCard('summary-camera');
  assert.equal(deleted.card_id, 'summary-camera');
  assert.equal(await store.getSummaryQueryCard('summary-camera'), null);
});

test('saved queries preserve overview flag and support patch/delete operations', async () => {
  const pool = createFakePool();
  const store = createMarketplaceConfigPostgresStore({
    pool,
    nowIso: () => '2026-01-03T00:00:00.000Z',
  });

  const saved = await store.upsertSavedQuery({
    label: 'High Value',
    query: 'price:>500',
    showInOverview: true,
  });
  assert.equal(saved.query_id, 'saved-High-Value'.toLowerCase());
  assert.equal(saved.showInOverview, true);
  assert.equal(saved.source, 'server');
  const insert = pool.calls.find((call) => /INSERT INTO saved_queries/.test(call.sql));
  assert.ok(insert);
  assert.deepEqual(insert.params, [
    'saved-high-value',
    'High Value',
    'price:>500',
    1,
    '2026-01-03T00:00:00.000Z',
    '2026-01-03T00:00:00.000Z',
  ]);

  const hidden = await store.setSavedQueryOverview('saved-high-value', false);
  assert.equal(hidden.showInOverview, false);
  const update = pool.calls.find((call) => /UPDATE saved_queries/.test(call.sql));
  assert.ok(update);
  assert.deepEqual(update.params, [0, '2026-01-03T00:00:00.000Z', 'saved-high-value']);

  const rows = await store.listSavedQueries();
  assert.equal(rows.length, 1);
  const deleted = await store.deleteSavedQuery('saved-high-value');
  assert.equal(deleted.query_id, 'saved-high-value');
  assert.equal(await store.getSavedQuery('saved-high-value'), null);
  await store.close();
  assert.equal(pool.ended, true);
});
