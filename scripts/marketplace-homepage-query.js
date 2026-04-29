const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

const FIELD_ALIASES = {
  id: 'listing_id',
  listing_id: 'listing_id',
  status: 'detail_status',
  detail_status: 'detail_status',
  title: 'title',
  card_title: 'card_title',
  detail_title: 'detail_title',
  text: 'text',
  card_text: 'card_text',
  seller: 'detail_seller_name',
  location: 'detail_location',
  price: 'price',
  rank: 'last_seen_rank',
  source: 'source',
  keyword: 'source_keyword',
  source_keyword: 'source_keyword',
  outcome: 'detail_status',
  before: 'before',
  after: 'after',
  sort: 'sort',
};

function tokenizeQuery(query) {
  const tokens = [];
  const pattern = /"([^"]*)"|(\S+)/g;
  let match;

  while ((match = pattern.exec(String(query || '')))) {
    tokens.push(match[1] ?? match[2]);
  }

  return tokens;
}

function parseQuery(query) {
  const tokens = tokenizeQuery(query);
  const parsed = {
    raw: String(query || ''),
    terms: [],
    filters: [],
    sort: 'recent',
  };

  for (const token of tokens) {
    const separatorIndex = token.indexOf(':');
    if (separatorIndex > 0) {
      const rawField = token.slice(0, separatorIndex).toLowerCase();
      const rawValue = token.slice(separatorIndex + 1).trim();
      const field = FIELD_ALIASES[rawField];

      if (field && rawValue) {
        if (field === 'sort') {
          parsed.sort = normalizeSort(rawValue);
        } else {
          parsed.filters.push({ field, value: rawValue });
        }
        continue;
      }
    }

    if (token.trim()) {
      parsed.terms.push(token.trim());
    }
  }

  return parsed;
}

function normalizeSort(value) {
  const normalized = String(value || '').toLowerCase();
  switch (normalized) {
    case 'recent':
    case 'new':
      return 'recent';
    case 'oldest':
      return 'oldest';
    case 'rank':
      return 'rank';
    case 'price':
      return 'price';
    default:
      return 'recent';
  }
}

function parseNumericPriceText(text) {
  const match = String(text || '').match(/(\d[\d,]*)/);
  if (!match) {
    return null;
  }

  const parsed = Number.parseInt(match[1].replace(/,/g, ''), 10);
  return Number.isFinite(parsed) ? parsed : null;
}

function escapeLikeValue(value) {
  return String(value || '')
    .replace(/\\/g, '\\\\')
    .replace(/%/g, '\\%')
    .replace(/_/g, '\\_');
}

function parsePriceFilter(value) {
  const normalized = String(value || '').trim();
  const rangeMatch = normalized.match(/^(\d+)-(\d+)$/);
  if (rangeMatch) {
    return {
      min: Number.parseInt(rangeMatch[1], 10),
      max: Number.parseInt(rangeMatch[2], 10),
    };
  }

  const comparatorMatch = normalized.match(/^(<=|>=|<|>|=)(\d+)$/);
  if (comparatorMatch) {
    return {
      operator: comparatorMatch[1],
      value: Number.parseInt(comparatorMatch[2], 10),
    };
  }

  const exact = Number.parseInt(normalized, 10);
  if (Number.isFinite(exact)) {
    return {
      operator: '=',
      value: exact,
    };
  }

  return null;
}

function buildPriceExpression() {
  return `
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
}

function buildWhereClause(parsedQuery) {
  const clauses = [];
  const params = [];
  const priceExpression = buildPriceExpression();

  for (const term of parsedQuery.terms) {
    const likeValue = `%${escapeLikeValue(term)}%`;
    clauses.push(`(
      listing_id LIKE ? ESCAPE '\\'
      OR href LIKE ? ESCAPE '\\'
      OR card_title LIKE ? ESCAPE '\\'
      OR card_text LIKE ? ESCAPE '\\'
      OR detail_title LIKE ? ESCAPE '\\'
      OR detail_location LIKE ? ESCAPE '\\'
      OR detail_seller_name LIKE ? ESCAPE '\\'
      OR source LIKE ? ESCAPE '\\'
      OR source_keyword LIKE ? ESCAPE '\\'
      OR detail_json LIKE ? ESCAPE '\\'
    )`);
    params.push(likeValue, likeValue, likeValue, likeValue, likeValue, likeValue, likeValue, likeValue, likeValue, likeValue);
  }

  for (const filter of parsedQuery.filters) {
    switch (filter.field) {
      case 'listing_id':
        clauses.push('listing_id LIKE ? ESCAPE \'\\\\\'');
        params.push(`%${escapeLikeValue(filter.value)}%`);
        break;
      case 'detail_status':
        clauses.push('detail_status = ?');
        params.push(String(filter.value).toLowerCase());
        break;
      case 'card_title':
      case 'detail_title':
      case 'detail_seller_name':
      case 'detail_location':
      case 'source':
      case 'source_keyword':
        clauses.push(`${filter.field} LIKE ? ESCAPE '\\'`);
        params.push(`%${escapeLikeValue(filter.value)}%`);
        break;
      case 'title':
        clauses.push('(card_title LIKE ? ESCAPE \'\\\\\' OR detail_title LIKE ? ESCAPE \'\\\\\')');
        params.push(`%${escapeLikeValue(filter.value)}%`, `%${escapeLikeValue(filter.value)}%`);
        break;
      case 'text':
        clauses.push('(card_text LIKE ? ESCAPE \'\\\\\' OR detail_json LIKE ? ESCAPE \'\\\\\')');
        params.push(`%${escapeLikeValue(filter.value)}%`, `%${escapeLikeValue(filter.value)}%`);
        break;
      case 'before':
        clauses.push('last_seen_at <= ?');
        params.push(filter.value);
        break;
      case 'after':
        clauses.push('last_seen_at >= ?');
        params.push(filter.value);
        break;
      case 'last_seen_rank': {
        const rank = Number.parseInt(filter.value, 10);
        if (Number.isFinite(rank)) {
          clauses.push('last_seen_rank = ?');
          params.push(rank);
        }
        break;
      }
      case 'price': {
        const parsedPrice = parsePriceFilter(filter.value);
        if (!parsedPrice) {
          break;
        }

        if (Object.prototype.hasOwnProperty.call(parsedPrice, 'min')) {
          clauses.push(`(${priceExpression}) BETWEEN ? AND ?`);
          params.push(parsedPrice.min, parsedPrice.max);
        } else {
          clauses.push(`(${priceExpression}) ${parsedPrice.operator} ?`);
          params.push(parsedPrice.value);
        }
        break;
      }
      default:
        break;
    }
  }

  return {
    sql: clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '',
    params,
  };
}

function buildOrderBy(sort) {
  switch (sort) {
    case 'oldest':
      return 'ORDER BY last_seen_at ASC, first_seen_at ASC';
    case 'rank':
      return 'ORDER BY COALESCE(last_seen_rank, 999999) ASC, last_seen_at DESC';
    case 'price':
      return `ORDER BY ${buildPriceExpression()} DESC NULLS LAST, last_seen_at DESC`;
    case 'recent':
    default:
      return 'ORDER BY last_seen_at DESC, first_seen_at DESC';
  }
}

function clampLimit(limit) {
  const parsed = Number.parseInt(limit, 10);
  if (!Number.isFinite(parsed) || parsed < 1) {
    return DEFAULT_LIMIT;
  }

  return Math.min(parsed, MAX_LIMIT);
}

function buildListingsQuery(options = {}) {
  const parsedQuery = parseQuery(options.query || '');
  const where = buildWhereClause(parsedQuery);
  const limit = clampLimit(options.limit);
  const offset = Math.max(0, Number.parseInt(options.offset, 10) || 0);
  const sql = `
    SELECT
      listing_id,
      href,
      source,
      source_keyword,
      card_title,
      card_text,
      first_seen_at,
      last_seen_at,
      last_seen_rank,
      detail_status,
      detail_attempts,
      detail_last_error,
      detail_completed_at,
      detail_title,
      detail_price,
      detail_location,
      detail_condition,
      detail_seller_name,
      screenshot_path,
      snapshot_path,
      ${buildPriceExpression()} AS numeric_price
    FROM homepage_listings
    ${where.sql}
    ${buildOrderBy(parsedQuery.sort)}
    LIMIT ? OFFSET ?
  `;

  return {
    parsedQuery,
    sql,
    params: [...where.params, limit, offset],
    limit,
    offset,
  };
}

function buildCountQuery(options = {}) {
  const parsedQuery = parseQuery(options.query || '');
  const where = buildWhereClause(parsedQuery);
  return {
    parsedQuery,
    sql: `
      SELECT COUNT(*) AS total
      FROM homepage_listings
      ${where.sql}
    `,
    params: where.params,
  };
}

module.exports = {
  parseQuery,
  buildListingsQuery,
  buildCountQuery,
  clampLimit,
};
