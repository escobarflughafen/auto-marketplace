const LISTING_PRICE_SQL = `
  COALESCE(
    CAST(NULLIF(REPLACE(REPLACE(REPLACE(detail_price, 'CA$', ''), '$', ''), ',', ''), '') AS INTEGER),
    CAST(NULLIF(REPLACE(REPLACE(
      CASE
        WHEN card_text LIKE '%CA$ %'
          THEN TRIM(SUBSTR(SUBSTR(card_text, INSTR(card_text, 'CA$ ') + 4), 1, INSTR(SUBSTR(card_text, INSTR(card_text, 'CA$ ') + 4), ' |') - 1))
        ELSE ''
      END
    , ',', ''), ' ', ''), '') AS INTEGER)
  )
`;

const COMMON_TEXT_OPERATORS = ['contains', '!contains', '==', '!=', '=~', '!~', 'startswith', '!startswith', 'endswith', '!endswith', 'in', '!in'];
const COMMON_ENUM_OPERATORS = ['==', '!=', '=~', '!~', 'in', '!in'];
const COMMON_NUMBER_OPERATORS = ['==', '!=', '<', '<=', '>', '>=', 'between', 'in', '!in'];
const COMMON_DATE_OPERATORS = ['==', '!=', '<', '<=', '>', '>=', 'between'];

const SOURCES = {
  listings: {
    label: 'Listings',
    table: 'homepage_listings',
    defaultSort: { field: 'last_seen_at', direction: 'desc' },
    fields: [
      { name: 'id', label: 'Listing ID', type: 'text', column: 'listing_id', aliases: ['listing_id'], indexed: true, operators: COMMON_TEXT_OPERATORS },
      { name: 'status', label: 'Status', type: 'enum', column: 'detail_status', aliases: ['detail_status', 'outcome'], indexed: true, values: ['pending', 'processing', 'done', 'error', 'sold', 'pending_sale'], operators: COMMON_ENUM_OPERATORS },
      { name: 'source', label: 'Source', type: 'enum', column: 'source', indexed: true, values: ['homepage', 'search', 'manual'], operators: COMMON_ENUM_OPERATORS },
      { name: 'keyword', label: 'Source keyword', type: 'text', column: 'source_keyword', aliases: ['source_keyword'], indexed: true, operators: COMMON_TEXT_OPERATORS },
      { name: 'title', label: 'Title', type: 'text', columns: ['card_title', 'detail_title'], aliases: ['card_title', 'detail_title'], operators: COMMON_TEXT_OPERATORS },
      { name: 'text', label: 'Card/detail text', type: 'text', columns: ['card_text', 'detail_json'], aliases: ['card_text', 'detail_text', 'description'], operators: COMMON_TEXT_OPERATORS },
      { name: 'seller', label: 'Seller', type: 'text', column: 'detail_seller_name', aliases: ['detail_seller_name'], operators: COMMON_TEXT_OPERATORS },
      { name: 'location', label: 'Location', type: 'text', column: 'detail_location', aliases: ['detail_location'], operators: COMMON_TEXT_OPERATORS },
      { name: 'condition', label: 'Condition', type: 'text', column: 'detail_condition', aliases: ['detail_condition'], operators: COMMON_TEXT_OPERATORS },
      { name: 'price', label: 'Price', type: 'number', expression: LISTING_PRICE_SQL, sortable: true, operators: COMMON_NUMBER_OPERATORS },
      { name: 'rank', label: 'Rank', type: 'number', column: 'last_seen_rank', aliases: ['last_seen_rank'], indexed: true, operators: COMMON_NUMBER_OPERATORS },
      { name: 'attempts', label: 'Attempts', type: 'number', column: 'detail_attempts', aliases: ['detail_attempts'], operators: COMMON_NUMBER_OPERATORS },
      { name: 'last_seen_at', label: 'Last seen', type: 'date', column: 'last_seen_at', aliases: ['seen', 'recent'], indexed: true, operators: COMMON_DATE_OPERATORS },
      { name: 'first_seen_at', label: 'First seen', type: 'date', column: 'first_seen_at', aliases: ['first_seen'], indexed: true, operators: COMMON_DATE_OPERATORS },
      { name: 'completed_at', label: 'Completed', type: 'date', column: 'detail_completed_at', aliases: ['completed', 'detail_completed_at'], operators: COMMON_DATE_OPERATORS },
    ],
  },
  events: {
    label: 'Worker events',
    fields: [
      { name: 'worker_type', label: 'Worker type', type: 'enum', values: ['collector', 'resolver', 'recommendation', 'server'], operators: COMMON_ENUM_OPERATORS },
      { name: 'event_type', label: 'Event type', type: 'text', operators: COMMON_TEXT_OPERATORS },
      { name: 'created_at', label: 'Created', type: 'date', operators: COMMON_DATE_OPERATORS },
    ],
  },
  workers: {
    label: 'Workers',
    fields: [
      { name: 'status', label: 'Status', type: 'enum', values: ['running', 'starting', 'stopping', 'lost', 'failed', 'completed'], operators: COMMON_ENUM_OPERATORS },
      { name: 'worker_type', label: 'Worker type', type: 'enum', values: ['collector', 'resolver'], operators: COMMON_ENUM_OPERATORS },
      { name: 'started_at', label: 'Started', type: 'date', operators: COMMON_DATE_OPERATORS },
    ],
  },
  recommendations: {
    label: 'Recommendations',
    fields: [
      { name: 'status', label: 'Status', type: 'enum', values: ['queued', 'saved', 'dismissed'], operators: COMMON_ENUM_OPERATORS },
      { name: 'score', label: 'Score', type: 'number', operators: COMMON_NUMBER_OPERATORS },
      { name: 'created_at', label: 'Created', type: 'date', operators: COMMON_DATE_OPERATORS },
    ],
  },
};

function sourceNames() {
  return Object.keys(SOURCES);
}

function getSource(name = 'listings') {
  return SOURCES[String(name || 'listings').toLowerCase()] || null;
}

function fieldsForSource(sourceName = 'listings') {
  return getSource(sourceName)?.fields || [];
}

function fieldLookupForSource(sourceName = 'listings') {
  const lookup = new Map();
  for (const field of fieldsForSource(sourceName)) {
    lookup.set(field.name.toLowerCase(), field);
    for (const alias of field.aliases || []) {
      lookup.set(String(alias).toLowerCase(), field);
    }
  }
  return lookup;
}

function resolveField(sourceName, fieldName) {
  return fieldLookupForSource(sourceName).get(String(fieldName || '').toLowerCase()) || null;
}

function fieldSuggestions(sourceName = 'listings') {
  return fieldsForSource(sourceName).map((field) => ({
    label: field.name,
    kind: 'field',
    insertText: field.name,
    detail: `${field.label} (${field.type})`,
    fieldType: field.type,
    score: field.indexed ? 95 : 80,
  }));
}

module.exports = {
  SOURCES,
  LISTING_PRICE_SQL,
  sourceNames,
  getSource,
  fieldsForSource,
  resolveField,
  fieldSuggestions,
};
