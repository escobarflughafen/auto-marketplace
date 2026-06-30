const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;
const {
  looksLikeLiteKql,
  buildLiteListingsQuery,
  buildLiteListingIdsQuery,
  buildLiteCountQuery,
  buildLiteListingsStatsQueries,
} = require('./lite-kql-postgres');
const { parseQuery, clampLimit: clampSqliteLimit } = require('./marketplace-homepage-query');
const { POSTGRES_LISTING_PRICE_SQL } = require('./postgres-price-sql');

const TEXT_FIELDS = new Set([
  'listing_id',
  'href',
  'card_title',
  'card_text',
  'detail_title',
  'detail_location',
  'detail_seller_name',
  'detail_condition',
  'source',
  'source_keyword',
  'detail_json',
]);

const NUMERIC_FIELDS = new Set([
  'price',
  'last_seen_rank',
  'detail_attempts',
]);

const SORT_FIELDS = new Set([
  'id',
  'listing_id',
  'status',
  'source',
  'keyword',
  'source_keyword',
  'rank',
  'price',
  'title',
  'seller',
  'condition',
  'attempts',
  'location',
  'first_seen',
  'completed',
  'seen',
  'recent',
  'oldest',
]);

function createPlaceholderState() {
  let index = 0;
  return {
    next() {
      index += 1;
      return `$${index}`;
    },
  };
}

function escapeLikeValue(value) {
  return String(value || '')
    .replace(/\\/g, '\\\\')
    .replace(/%/g, '\\%')
    .replace(/_/g, '\\_');
}

function normalizeSort(value) {
  const normalized = String(value || '').toLowerCase();
  switch (normalized) {
    case 'recent':
    case 'new':
    case 'seen':
      return 'recent';
    case 'oldest':
      return 'oldest';
    case 'rank':
      return 'rank';
    case 'price':
      return 'price';
    case 'id':
    case 'listing_id':
      return 'id';
    case 'status':
      return 'status';
    case 'source':
      return 'source';
    case 'keyword':
    case 'source_keyword':
      return 'keyword';
    case 'title':
      return 'title';
    case 'seller':
      return 'seller';
    case 'condition':
      return 'condition';
    case 'attempts':
      return 'attempts';
    case 'location':
      return 'location';
    case 'first_seen':
      return 'first_seen';
    case 'completed':
      return 'completed';
    default:
      return 'recent';
  }
}

function normalizeSortDirection(value, fallback = 'desc') {
  const normalized = String(value || '').toLowerCase();
  if (normalized === 'asc' || normalized === 'ascending') return 'asc';
  if (normalized === 'desc' || normalized === 'descending') return 'desc';
  return fallback;
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
  return Number.isFinite(exact) ? { operator: '=', value: exact } : null;
}

function parseComparableNumber(value) {
  const parsed = Number.parseFloat(String(value || '').replace(/,/g, ''));
  return Number.isFinite(parsed) ? parsed : null;
}

function buildPriceExpression() {
  return POSTGRES_LISTING_PRICE_SQL;
}

function buildFreeTextCondition(term, placeholders) {
  const likeValue = `%${escapeLikeValue(term)}%`;
  const params = [];
  const clauses = [
    'listing_id',
    'href',
    'card_title',
    'card_text',
    'detail_title',
    'detail_location',
    'detail_seller_name',
    'source',
    'source_keyword',
    'detail_json',
  ].map((field) => {
    params.push(likeValue);
    return `${field} ILIKE ${placeholders.next()} ESCAPE E'\\\\'`;
  });
  return {
    sql: `(${clauses.join('\n      OR ')})`,
    params,
  };
}

function fieldSqlExpression(field, priceExpression) {
  if (field === 'price') return priceExpression;
  if (TEXT_FIELDS.has(field) || NUMERIC_FIELDS.has(field) || ['detail_status', 'last_seen_at'].includes(field)) return field;
  return null;
}

function buildTextCondition(field, operator, value, placeholders) {
  const escaped = escapeLikeValue(value);
  const not = operator.startsWith('!') || operator === '!=';
  let pattern = escaped;

  if (operator.includes('contains') || operator.includes('has') || operator === '=~' || operator === '!~') {
    pattern = `%${escaped}%`;
  } else if (operator.includes('startswith')) {
    pattern = `${escaped}%`;
  } else if (operator.includes('endswith')) {
    pattern = `%${escaped}`;
  }

  if (field === 'title') {
    const first = placeholders.next();
    const second = placeholders.next();
    return {
      sql: not
        ? `(card_title NOT ILIKE ${first} ESCAPE E'\\\\' AND detail_title NOT ILIKE ${second} ESCAPE E'\\\\')`
        : `(card_title ILIKE ${first} ESCAPE E'\\\\' OR detail_title ILIKE ${second} ESCAPE E'\\\\')`,
      params: [pattern, pattern],
    };
  }
  if (field === 'text') {
    const first = placeholders.next();
    const second = placeholders.next();
    return {
      sql: not
        ? `(card_text NOT ILIKE ${first} ESCAPE E'\\\\' AND detail_json NOT ILIKE ${second} ESCAPE E'\\\\')`
        : `(card_text ILIKE ${first} ESCAPE E'\\\\' OR detail_json ILIKE ${second} ESCAPE E'\\\\')`,
      params: [pattern, pattern],
    };
  }

  const placeholder = placeholders.next();
  if (operator === '==' || operator === '!=') {
    return {
      sql: `${field} ${operator === '!=' ? '!=' : '='} ${placeholder}`,
      params: [String(value)],
    };
  }

  return {
    sql: `${field} ${not ? 'NOT ILIKE' : 'ILIKE'} ${placeholder} ESCAPE E'\\\\'`,
    params: [pattern],
  };
}

function buildKqlCondition(node, priceExpression, placeholders) {
  if (!node) return null;
  if (node.type === 'term') return buildFreeTextCondition(node.value, placeholders);
  if (node.type === 'not') {
    const child = buildKqlCondition(node.child, priceExpression, placeholders);
    return child ? { sql: `NOT (${child.sql})`, params: child.params } : null;
  }
  if (node.type === 'and' || node.type === 'or') {
    const left = buildKqlCondition(node.left, priceExpression, placeholders);
    const right = buildKqlCondition(node.right, priceExpression, placeholders);
    if (!left) return right;
    if (!right) return left;
    return {
      sql: `(${left.sql}) ${node.type.toUpperCase()} (${right.sql})`,
      params: [...left.params, ...right.params],
    };
  }
  if (node.type !== 'condition') return null;

  const operator = node.operator;
  const value = node.values[0];
  if (!value && value !== 0) return null;

  if (operator === 'in' || operator === '!in') {
    const values = node.values.filter((item) => item !== '');
    if (!values.length) return null;
    if (node.field === 'title' || node.field === 'text') {
      const conditions = values.map((item) => buildTextCondition(node.field, operator === '!in' ? '!=' : '==', item, placeholders));
      return {
        sql: conditions.map((condition) => `(${condition.sql})`).join(operator === '!in' ? ' AND ' : ' OR '),
        params: conditions.flatMap((condition) => condition.params),
      };
    }
    return {
      sql: `${node.field} ${operator === '!in' ? 'NOT ' : ''}IN (${values.map(() => placeholders.next()).join(', ')})`,
      params: values,
    };
  }

  if (NUMERIC_FIELDS.has(node.field) || ['<', '<=', '>', '>='].includes(operator)) {
    const numericValue = parseComparableNumber(value);
    if (numericValue === null) return null;
    const expression = fieldSqlExpression(node.field, priceExpression);
    if (!expression) return null;
    return {
      sql: `(${expression}) ${operator === '==' ? '=' : operator} ${placeholders.next()}`,
      params: [numericValue],
    };
  }

  return buildTextCondition(node.field, operator, value, placeholders);
}

function buildWhereClause(parsedQuery, placeholders) {
  const clauses = [];
  const params = [];
  const priceExpression = buildPriceExpression();

  if (parsedQuery.expression) {
    const expression = buildKqlCondition(parsedQuery.expression, priceExpression, placeholders);
    if (expression) {
      clauses.push(expression.sql);
      params.push(...expression.params);
    }
  } else {
    for (const term of parsedQuery.terms) {
      const condition = buildFreeTextCondition(term, placeholders);
      clauses.push(condition.sql);
      params.push(...condition.params);
    }
  }

  for (const filter of parsedQuery.filters) {
    switch (filter.field) {
      case 'listing_id':
        clauses.push(`listing_id ILIKE ${placeholders.next()} ESCAPE E'\\\\'`);
        params.push(`%${escapeLikeValue(filter.value)}%`);
        break;
      case 'detail_status':
        clauses.push(`detail_status = ${placeholders.next()}`);
        params.push(String(filter.value).toLowerCase());
        break;
      case 'card_title':
      case 'detail_title':
      case 'detail_seller_name':
      case 'detail_location':
      case 'source':
      case 'source_keyword':
        clauses.push(`${filter.field} ILIKE ${placeholders.next()} ESCAPE E'\\\\'`);
        params.push(`%${escapeLikeValue(filter.value)}%`);
        break;
      case 'title': {
        const first = placeholders.next();
        const second = placeholders.next();
        clauses.push(`(card_title ILIKE ${first} ESCAPE E'\\\\' OR detail_title ILIKE ${second} ESCAPE E'\\\\')`);
        params.push(`%${escapeLikeValue(filter.value)}%`, `%${escapeLikeValue(filter.value)}%`);
        break;
      }
      case 'text': {
        const first = placeholders.next();
        const second = placeholders.next();
        clauses.push(`(card_text ILIKE ${first} ESCAPE E'\\\\' OR detail_json ILIKE ${second} ESCAPE E'\\\\')`);
        params.push(`%${escapeLikeValue(filter.value)}%`, `%${escapeLikeValue(filter.value)}%`);
        break;
      }
      case 'before':
        clauses.push(`last_seen_at <= ${placeholders.next()}`);
        params.push(filter.value);
        break;
      case 'after':
        clauses.push(`last_seen_at >= ${placeholders.next()}`);
        params.push(filter.value);
        break;
      case 'last_seen_rank': {
        const rank = Number.parseInt(filter.value, 10);
        if (Number.isFinite(rank)) {
          clauses.push(`last_seen_rank = ${placeholders.next()}`);
          params.push(rank);
        }
        break;
      }
      case 'price': {
        const parsedPrice = parsePriceFilter(filter.value);
        if (!parsedPrice) break;
        if (Object.prototype.hasOwnProperty.call(parsedPrice, 'min')) {
          clauses.push(`(${priceExpression}) BETWEEN ${placeholders.next()} AND ${placeholders.next()}`);
          params.push(parsedPrice.min, parsedPrice.max);
        } else {
          clauses.push(`(${priceExpression}) ${parsedPrice.operator} ${placeholders.next()}`);
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
    placeholders,
  };
}

function buildOrderBy(sort, sortDirection = '') {
  const direction = normalizeSortDirection(sortDirection).toUpperCase();
  switch (sort) {
    case 'oldest':
      return 'ORDER BY last_seen_at ASC, first_seen_at ASC, listing_id ASC';
    case 'rank':
      return `ORDER BY COALESCE(last_seen_rank, 999999) ${direction}, last_seen_at DESC`;
    case 'price':
      return `ORDER BY ${buildPriceExpression()} ${direction} NULLS LAST, last_seen_at DESC`;
    case 'id':
      return `ORDER BY listing_id ${direction}, last_seen_at DESC`;
    case 'status':
      return `ORDER BY detail_status ${direction}, last_seen_at DESC`;
    case 'source':
      return `ORDER BY source ${direction}, last_seen_at DESC`;
    case 'keyword':
      return `ORDER BY source_keyword ${direction}, last_seen_at DESC`;
    case 'title':
      return `ORDER BY LOWER(COALESCE(NULLIF(detail_title, ''), NULLIF(card_title, ''), '')) ${direction}, last_seen_at DESC`;
    case 'location':
      return `ORDER BY LOWER(COALESCE(NULLIF(detail_location, ''), '')) ${direction}, last_seen_at DESC`;
    case 'seller':
      return `ORDER BY LOWER(COALESCE(NULLIF(detail_seller_name, ''), '')) ${direction}, last_seen_at DESC`;
    case 'condition':
      return `ORDER BY LOWER(COALESCE(NULLIF(detail_condition, ''), '')) ${direction}, last_seen_at DESC`;
    case 'attempts':
      return `ORDER BY detail_attempts ${direction}, last_seen_at DESC`;
    case 'first_seen':
      return `ORDER BY first_seen_at ${direction}, last_seen_at DESC`;
    case 'completed':
      return `ORDER BY COALESCE(NULLIF(detail_completed_at, ''), '') ${direction}, last_seen_at DESC`;
    case 'recent':
    default:
      return `ORDER BY last_seen_at ${direction}, first_seen_at ${direction}, listing_id ASC`;
  }
}

function clampLimit(limit) {
  const parsed = Number.parseInt(limit, 10);
  if (!Number.isFinite(parsed) || parsed < 1) return DEFAULT_LIMIT;
  return Math.min(parsed, MAX_LIMIT);
}

function normalizeExcludeListingIds(value) {
  const source = Array.isArray(value) ? value : [value];
  return [...new Set(source
    .flatMap((item) => String(item || '').split(','))
    .map((item) => item.trim())
    .filter(Boolean))];
}

function appendExcludeListingIds(where, excludeListingIds) {
  const ids = normalizeExcludeListingIds(excludeListingIds);
  if (!ids.length) return where;
  const excludeSql = `listing_id NOT IN (${ids.map(() => where.placeholders.next()).join(', ')})`;
  return {
    ...where,
    sql: where.sql ? `${where.sql} AND ${excludeSql}` : `WHERE ${excludeSql}`,
    params: [...where.params, ...ids],
  };
}

function buildListingsQuery(options = {}) {
  if (looksLikeLiteKql(options.query || '')) return buildLiteListingsQuery(options);
  const parsedQuery = parseQuery(options.query || '');
  if (SORT_FIELDS.has(String(options.sort || '').toLowerCase())) parsedQuery.sort = normalizeSort(options.sort);
  parsedQuery.sortDirection = normalizeSortDirection(
    options.sortDirection || options.sortDir,
    parsedQuery.sort === 'rank' ? 'asc' : 'desc',
  );
  const placeholders = createPlaceholderState();
  const where = appendExcludeListingIds(buildWhereClause(parsedQuery, placeholders), options.excludeListingIds);
  const limit = clampLimit(options.limit);
  const offset = Math.max(0, Number.parseInt(options.offset, 10) || 0);
  const limitPlaceholder = placeholders.next();
  const offsetPlaceholder = placeholders.next();
  return {
    parsedQuery: { ...parsedQuery, dialect: 'postgres' },
    sql: `
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
        detail_listed_ago,
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
      ${buildOrderBy(parsedQuery.sort, parsedQuery.sortDirection)}
      LIMIT ${limitPlaceholder} OFFSET ${offsetPlaceholder}
    `,
    params: [...where.params, limit, offset],
    limit,
    offset,
  };
}

function buildListingIdsQuery(options = {}) {
  if (looksLikeLiteKql(options.query || '')) return buildLiteListingIdsQuery(options);
  const parsedQuery = parseQuery(options.query || '');
  if (SORT_FIELDS.has(String(options.sort || '').toLowerCase())) parsedQuery.sort = normalizeSort(options.sort);
  parsedQuery.sortDirection = normalizeSortDirection(
    options.sortDirection || options.sortDir,
    parsedQuery.sort === 'rank' ? 'asc' : 'desc',
  );
  const placeholders = createPlaceholderState();
  const where = appendExcludeListingIds(buildWhereClause(parsedQuery, placeholders), options.excludeListingIds);
  const extraClauses = [];
  if (options.backlogOnly !== false) extraClauses.push("detail_status IN ('pending', 'error', 'processing')");
  const whereSql = [where.sql.replace(/^WHERE\s+/i, ''), ...extraClauses].filter(Boolean).join(' AND ');
  return {
    parsedQuery: { ...parsedQuery, dialect: 'postgres' },
    sql: `
      SELECT listing_id
      FROM homepage_listings
      ${whereSql ? `WHERE ${whereSql}` : ''}
      ${buildOrderBy(parsedQuery.sort, parsedQuery.sortDirection)}
    `,
    params: where.params,
  };
}

function buildCountQuery(options = {}) {
  if (looksLikeLiteKql(options.query || '')) return buildLiteCountQuery(options);
  const parsedQuery = parseQuery(options.query || '');
  const placeholders = createPlaceholderState();
  const where = appendExcludeListingIds(buildWhereClause(parsedQuery, placeholders), options.excludeListingIds);
  return {
    parsedQuery: { ...parsedQuery, dialect: 'postgres' },
    sql: `
      SELECT COUNT(*) AS total
      FROM homepage_listings
      ${where.sql}
    `,
    params: where.params,
  };
}

function buildStatsQueriesFromWhere(parsedQuery, where) {
  const priceExpression = buildPriceExpression();
  const pricedRowsSql = `
    SELECT ${priceExpression} AS numeric_price
    FROM homepage_listings
    ${where.sql}
  `;
  return {
    parsedQuery: { ...parsedQuery, dialect: 'postgres' },
    priceSummary: {
      sql: `
        SELECT
          COUNT(*) AS "totalRows",
          COUNT(numeric_price) AS "pricedCount",
          MIN(numeric_price) AS "priceMin",
          MAX(numeric_price) AS "priceMax",
          AVG(numeric_price) AS "priceAverage"
        FROM (${pricedRowsSql}) priced_rows
      `,
      params: where.params,
    },
    priceMedian: {
      sql: `
        WITH priced_rows AS (
          ${pricedRowsSql}
        ),
        numbered AS (
          SELECT
            numeric_price,
            ROW_NUMBER() OVER (ORDER BY numeric_price) AS "rowNumber",
            COUNT(*) OVER () AS "rowCount"
          FROM priced_rows
          WHERE numeric_price IS NOT NULL
        )
        SELECT AVG(numeric_price) AS "priceMedian"
        FROM numbered
        WHERE "rowNumber" IN (("rowCount" + 1) / 2, ("rowCount" + 2) / 2)
      `,
      params: where.params,
    },
    statusCounts: {
      sql: `
        SELECT COALESCE(NULLIF(detail_status, ''), 'unknown') AS label, COUNT(*) AS count
        FROM homepage_listings
        ${where.sql}
        GROUP BY label
        ORDER BY count DESC, label ASC
        LIMIT 12
      `,
      params: where.params,
    },
    sourceCounts: {
      sql: `
        SELECT COALESCE(NULLIF(source, ''), 'unknown') AS label, COUNT(*) AS count
        FROM homepage_listings
        ${where.sql}
        GROUP BY label
        ORDER BY count DESC, label ASC
        LIMIT 12
      `,
      params: where.params,
    },
    priceHistogram(range = {}) {
      const min = Number(range.min);
      const max = Number(range.max);
      const binCount = Math.max(2, Math.min(Number.parseInt(range.binCount, 10) || 6, 20));
      const width = Number.isFinite(min) && Number.isFinite(max) && max > min
        ? (max - min) / binCount
        : 1;
      const histogramPlaceholders = createPlaceholderState();
      const histogramWhere = appendExcludeListingIds(buildWhereClause(parsedQuery, histogramPlaceholders), where.excludeListingIds);
      const maxPlaceholder = histogramPlaceholders.next();
      const bucketPlaceholder = histogramPlaceholders.next();
      const minPlaceholder = histogramPlaceholders.next();
      const widthPlaceholder = histogramPlaceholders.next();
      const histogramPricedRowsSql = `
        SELECT ${priceExpression} AS numeric_price
        FROM homepage_listings
        ${histogramWhere.sql}
      `;
      return {
        sql: `
          SELECT bucket, COUNT(*) AS count
          FROM (
            SELECT
              CASE
                WHEN numeric_price >= ${maxPlaceholder} THEN ${bucketPlaceholder}
                ELSE FLOOR((numeric_price - ${minPlaceholder}) / ${widthPlaceholder})::BIGINT
              END AS bucket
            FROM (${histogramPricedRowsSql}) priced_rows
            WHERE numeric_price IS NOT NULL
          ) bucketed
          GROUP BY bucket
          ORDER BY bucket ASC
        `,
        params: [...histogramWhere.params, max, binCount - 1, min, width],
        binCount,
        min,
        max,
        width,
      };
    },
  };
}

function buildListingsStatsQueries(options = {}) {
  if (looksLikeLiteKql(options.query || '')) return buildLiteListingsStatsQueries(options);
  const parsedQuery = parseQuery(options.query || '');
  const placeholders = createPlaceholderState();
  const where = appendExcludeListingIds(buildWhereClause(parsedQuery, placeholders), options.excludeListingIds);
  return buildStatsQueriesFromWhere(parsedQuery, { ...where, excludeListingIds: options.excludeListingIds });
}

module.exports = {
  POSTGRES_LISTING_PRICE_SQL,
  parseQuery,
  buildListingsQuery,
  buildListingIdsQuery,
  buildCountQuery,
  buildListingsStatsQueries,
  clampLimit: clampSqliteLimit,
};
