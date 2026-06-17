const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;
const {
  looksLikeLiteKql,
  buildLiteListingsQuery,
  buildLiteListingIdsQuery,
  buildLiteCountQuery,
  buildLiteListingsStatsQueries,
} = require('./lite-kql-sqlite');

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
  condition: 'detail_condition',
  attempts: 'detail_attempts',
  first_seen: 'first_seen_at',
  completed: 'detail_completed_at',
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

function tokenizeQuery(query) {
  const tokens = [];
  const pattern = /"([^"]*)"|'([^']*)'|(==|!=|<=|>=|=~|!~|[():,<>])|(\S+)/g;
  let match;

  while ((match = pattern.exec(String(query || '')))) {
    tokens.push(match[1] ?? match[2] ?? match[3] ?? match[4]);
  }

  return tokens;
}

function isKqlOperator(value) {
  return [
    '==',
    '=',
    '!=',
    '=~',
    '!~',
    '<',
    '<=',
    '>',
    '>=',
    'contains',
    '!contains',
    'has',
    '!has',
    'startswith',
    '!startswith',
    'endswith',
    '!endswith',
    'in',
    '!in',
  ].includes(String(value || '').toLowerCase());
}

function parseQuery(query) {
  const tokens = tokenizeQuery(query);
  const parsed = {
    raw: String(query || ''),
    terms: [],
    filters: [],
    expression: null,
    sort: 'recent',
  };

  const expressionTokens = [];

  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
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

    if (String(token || '').toLowerCase() === 'sort' && tokens[index + 1] === ':' && tokens[index + 2]) {
      parsed.sort = normalizeSort(tokens[index + 2]);
      index += 2;
      continue;
    }

    if (token.trim()) {
      parsed.terms.push(token.trim());
      expressionTokens.push(token.trim());
    }
  }

  parsed.expression = parseKqlExpression(expressionTokens);
  return parsed;
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
  if (normalized === 'asc' || normalized === 'ascending') {
    return 'asc';
  }
  if (normalized === 'desc' || normalized === 'descending') {
    return 'desc';
  }
  return fallback;
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

function parseComparableNumber(value) {
  const parsed = Number.parseFloat(String(value || '').replace(/,/g, ''));
  return Number.isFinite(parsed) ? parsed : null;
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

function normalizeKqlField(rawField) {
  return FIELD_ALIASES[String(rawField || '').toLowerCase()] || '';
}

function normalizeKqlOperator(rawOperator) {
  const operator = String(rawOperator || '').toLowerCase();
  return operator === '=' ? '==' : operator;
}

function isLogicalToken(token, value) {
  return String(token || '').toLowerCase() === value;
}

function parseKqlExpression(tokens) {
  if (!tokens.length || !tokens.some((token) => isKqlOperator(token) || ['and', 'or', 'not', '(', ')'].includes(String(token).toLowerCase()))) {
    return null;
  }

  let index = 0;

  function peek() {
    return tokens[index];
  }

  function consume() {
    const token = tokens[index];
    index += 1;
    return token;
  }

  function parseValueList() {
    const values = [];
    if (peek() !== '(') {
      const value = consume();
      return value ? [value] : values;
    }

    consume();
    while (index < tokens.length && peek() !== ')') {
      if (peek() === ',') {
        consume();
        continue;
      }
      values.push(consume());
    }
    if (peek() === ')') {
      consume();
    }
    return values;
  }

  function parseCondition() {
    if (isLogicalToken(peek(), 'not')) {
      consume();
      return {
        type: 'not',
        child: parsePrimary(),
      };
    }

    const fieldToken = peek();
    const field = normalizeKqlField(fieldToken);
    if (field && isKqlOperator(tokens[index + 1])) {
      consume();
      const operator = normalizeKqlOperator(consume());
      const values = operator === 'in' || operator === '!in'
        ? parseValueList()
        : [consume()].filter((value) => value !== undefined);
      if (field === 'sort') {
        return null;
      }
      return {
        type: 'condition',
        field,
        operator,
        values,
      };
    }

    const term = consume();
    if (!term || ['and', 'or', ')'].includes(String(term).toLowerCase())) {
      return null;
    }
    return {
      type: 'term',
      value: term,
    };
  }

  function parsePrimary() {
    if (peek() === '(') {
      consume();
      const expression = parseOr();
      if (peek() === ')') {
        consume();
      }
      return expression;
    }
    return parseCondition();
  }

  function parseAnd() {
    let node = parsePrimary();
    while (index < tokens.length && isLogicalToken(peek(), 'and')) {
      consume();
      node = {
        type: 'and',
        left: node,
        right: parsePrimary(),
      };
    }
    return node;
  }

  function parseOr() {
    let node = parseAnd();
    while (index < tokens.length && isLogicalToken(peek(), 'or')) {
      consume();
      node = {
        type: 'or',
        left: node,
        right: parseAnd(),
      };
    }
    return node;
  }

  const expression = parseOr();
  return index >= tokens.length ? expression : null;
}

function buildFreeTextCondition(term) {
  const likeValue = `%${escapeLikeValue(term)}%`;
  return {
    sql: `(
      listing_id LIKE ? ESCAPE char(92)
      OR href LIKE ? ESCAPE char(92)
      OR card_title LIKE ? ESCAPE char(92)
      OR card_text LIKE ? ESCAPE char(92)
      OR detail_title LIKE ? ESCAPE char(92)
      OR detail_location LIKE ? ESCAPE char(92)
      OR detail_seller_name LIKE ? ESCAPE char(92)
      OR source LIKE ? ESCAPE char(92)
      OR source_keyword LIKE ? ESCAPE char(92)
      OR detail_json LIKE ? ESCAPE char(92)
    )`,
    params: [likeValue, likeValue, likeValue, likeValue, likeValue, likeValue, likeValue, likeValue, likeValue, likeValue],
  };
}

function fieldSqlExpression(field, priceExpression) {
  if (field === 'price') {
    return priceExpression;
  }
  if (TEXT_FIELDS.has(field) || NUMERIC_FIELDS.has(field) || ['detail_status', 'last_seen_at'].includes(field)) {
    return field;
  }
  if (field === 'title') {
    return null;
  }
  if (field === 'text') {
    return null;
  }
  return null;
}

function buildTextCondition(field, operator, value) {
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

  const positiveOperator = not ? 'NOT LIKE' : 'LIKE';
  if (field === 'title') {
    return {
      sql: not
        ? '(card_title NOT LIKE ? ESCAPE char(92) AND detail_title NOT LIKE ? ESCAPE char(92))'
        : '(card_title LIKE ? ESCAPE char(92) OR detail_title LIKE ? ESCAPE char(92))',
      params: [pattern, pattern],
    };
  }
  if (field === 'text') {
    return {
      sql: not
        ? '(card_text NOT LIKE ? ESCAPE char(92) AND detail_json NOT LIKE ? ESCAPE char(92))'
        : '(card_text LIKE ? ESCAPE char(92) OR detail_json LIKE ? ESCAPE char(92))',
      params: [pattern, pattern],
    };
  }

  if (operator === '==' || operator === '!=') {
    return {
      sql: `${field} ${operator === '!=' ? '!=' : '='} ?`,
      params: [String(value)],
    };
  }

  return {
    sql: `${field} ${positiveOperator} ? ESCAPE char(92)`,
    params: [pattern],
  };
}

function buildKqlCondition(node, priceExpression) {
  if (!node) {
    return null;
  }

  if (node.type === 'term') {
    return buildFreeTextCondition(node.value);
  }

  if (node.type === 'not') {
    const child = buildKqlCondition(node.child, priceExpression);
    return child ? { sql: `NOT (${child.sql})`, params: child.params } : null;
  }

  if (node.type === 'and' || node.type === 'or') {
    const left = buildKqlCondition(node.left, priceExpression);
    const right = buildKqlCondition(node.right, priceExpression);
    if (!left) return right;
    if (!right) return left;
    return {
      sql: `(${left.sql}) ${node.type.toUpperCase()} (${right.sql})`,
      params: [...left.params, ...right.params],
    };
  }

  if (node.type !== 'condition') {
    return null;
  }

  const operator = node.operator;
  const value = node.values[0];
  if (!value && value !== 0) {
    return null;
  }

  if (operator === 'in' || operator === '!in') {
    const values = node.values.filter((item) => item !== '');
    if (!values.length) {
      return null;
    }

    if (node.field === 'title' || node.field === 'text') {
      const conditions = values.map((item) => buildTextCondition(node.field, operator === '!in' ? '!=' : '==', item));
      return {
        sql: conditions.map((condition) => `(${condition.sql})`).join(operator === '!in' ? ' AND ' : ' OR '),
        params: conditions.flatMap((condition) => condition.params),
      };
    }

    const placeholders = values.map(() => '?').join(', ');
    return {
      sql: `${node.field} ${operator === '!in' ? 'NOT ' : ''}IN (${placeholders})`,
      params: values,
    };
  }

  if (NUMERIC_FIELDS.has(node.field) || ['<', '<=', '>', '>='].includes(operator)) {
    const numericValue = parseComparableNumber(value);
    if (numericValue === null) {
      return null;
    }
    const expression = fieldSqlExpression(node.field, priceExpression);
    if (!expression) {
      return null;
    }
    const sqlOperator = operator === '==' ? '=' : operator;
    return {
      sql: `(${expression}) ${sqlOperator} ?`,
      params: [numericValue],
    };
  }

  return buildTextCondition(node.field, operator, value);
}

function buildWhereClause(parsedQuery) {
  const clauses = [];
  const params = [];
  const priceExpression = buildPriceExpression();

  if (parsedQuery.expression) {
    const expression = buildKqlCondition(parsedQuery.expression, priceExpression);
    if (expression) {
      clauses.push(expression.sql);
      params.push(...expression.params);
    }
  } else {
    for (const term of parsedQuery.terms) {
      const condition = buildFreeTextCondition(term);
      clauses.push(condition.sql);
      params.push(...condition.params);
    }
  }

  for (const filter of parsedQuery.filters) {
    switch (filter.field) {
      case 'listing_id':
        clauses.push('listing_id LIKE ? ESCAPE char(92)');
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
        clauses.push(`${filter.field} LIKE ? ESCAPE char(92)`);
        params.push(`%${escapeLikeValue(filter.value)}%`);
        break;
      case 'title':
        clauses.push('(card_title LIKE ? ESCAPE char(92) OR detail_title LIKE ? ESCAPE char(92))');
        params.push(`%${escapeLikeValue(filter.value)}%`, `%${escapeLikeValue(filter.value)}%`);
        break;
      case 'text':
        clauses.push('(card_text LIKE ? ESCAPE char(92) OR detail_json LIKE ? ESCAPE char(92))');
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

function buildOrderBy(sort, sortDirection = '') {
  const direction = normalizeSortDirection(sortDirection);
  switch (sort) {
    case 'oldest':
      return 'ORDER BY last_seen_at ASC, first_seen_at ASC';
    case 'rank':
      return `ORDER BY COALESCE(last_seen_rank, 999999) ${direction.toUpperCase()}, last_seen_at DESC`;
    case 'price':
      return `ORDER BY ${buildPriceExpression()} ${direction.toUpperCase()} NULLS LAST, last_seen_at DESC`;
    case 'id':
      return `ORDER BY listing_id ${direction.toUpperCase()}, last_seen_at DESC`;
    case 'status':
      return `ORDER BY detail_status ${direction.toUpperCase()}, last_seen_at DESC`;
    case 'source':
      return `ORDER BY source ${direction.toUpperCase()}, last_seen_at DESC`;
    case 'keyword':
      return `ORDER BY source_keyword ${direction.toUpperCase()}, last_seen_at DESC`;
    case 'title':
      return `ORDER BY LOWER(COALESCE(NULLIF(detail_title, ''), NULLIF(card_title, ''), '')) ${direction.toUpperCase()}, last_seen_at DESC`;
    case 'location':
      return `ORDER BY LOWER(COALESCE(NULLIF(detail_location, ''), '')) ${direction.toUpperCase()}, last_seen_at DESC`;
    case 'seller':
      return `ORDER BY LOWER(COALESCE(NULLIF(detail_seller_name, ''), '')) ${direction.toUpperCase()}, last_seen_at DESC`;
    case 'condition':
      return `ORDER BY LOWER(COALESCE(NULLIF(detail_condition, ''), '')) ${direction.toUpperCase()}, last_seen_at DESC`;
    case 'attempts':
      return `ORDER BY detail_attempts ${direction.toUpperCase()}, last_seen_at DESC`;
    case 'first_seen':
      return `ORDER BY first_seen_at ${direction.toUpperCase()}, last_seen_at DESC`;
    case 'completed':
      return `ORDER BY COALESCE(NULLIF(detail_completed_at, ''), '') ${direction.toUpperCase()}, last_seen_at DESC`;
    case 'recent':
    default:
      return `ORDER BY last_seen_at ${direction.toUpperCase()}, first_seen_at ${direction.toUpperCase()}`;
  }
}

function clampLimit(limit) {
  const parsed = Number.parseInt(limit, 10);
  if (!Number.isFinite(parsed) || parsed < 1) {
    return DEFAULT_LIMIT;
  }

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
  if (!ids.length) {
    return where;
  }

  const excludeSql = `listing_id NOT IN (${ids.map(() => '?').join(', ')})`;
  return {
    sql: where.sql
      ? `${where.sql} AND ${excludeSql}`
      : `WHERE ${excludeSql}`,
    params: [...where.params, ...ids],
  };
}

function buildListingsQuery(options = {}) {
  if (looksLikeLiteKql(options.query || '')) {
    return buildLiteListingsQuery(options);
  }
  const parsedQuery = parseQuery(options.query || '');
  if (SORT_FIELDS.has(String(options.sort || '').toLowerCase())) {
    parsedQuery.sort = normalizeSort(options.sort);
  }
  parsedQuery.sortDirection = normalizeSortDirection(
    options.sortDirection || options.sortDir,
    parsedQuery.sort === 'rank' ? 'asc' : 'desc',
  );
  const where = appendExcludeListingIds(buildWhereClause(parsedQuery), options.excludeListingIds);
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

function buildListingIdsQuery(options = {}) {
  if (looksLikeLiteKql(options.query || '')) {
    return buildLiteListingIdsQuery(options);
  }
  const parsedQuery = parseQuery(options.query || '');
  if (SORT_FIELDS.has(String(options.sort || '').toLowerCase())) {
    parsedQuery.sort = normalizeSort(options.sort);
  }
  parsedQuery.sortDirection = normalizeSortDirection(
    options.sortDirection || options.sortDir,
    parsedQuery.sort === 'rank' ? 'asc' : 'desc',
  );
  const where = appendExcludeListingIds(buildWhereClause(parsedQuery), options.excludeListingIds);
  const extraClauses = [];
  if (options.backlogOnly !== false) {
    extraClauses.push("detail_status IN ('pending', 'error', 'processing')");
  }

  const whereSql = [where.sql.replace(/^WHERE\s+/i, ''), ...extraClauses]
    .filter(Boolean)
    .join(' AND ');

  return {
    parsedQuery,
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
  if (looksLikeLiteKql(options.query || '')) {
    return buildLiteCountQuery(options);
  }
  const parsedQuery = parseQuery(options.query || '');
  const where = appendExcludeListingIds(buildWhereClause(parsedQuery), options.excludeListingIds);
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

function buildStatsQueriesFromWhere(parsedQuery, where) {
  const priceExpression = buildPriceExpression();
  const pricedRowsSql = `
    SELECT ${priceExpression} AS numeric_price
    FROM homepage_listings
    ${where.sql}
  `;
  return {
    parsedQuery,
    priceSummary: {
      sql: `
        SELECT
          COUNT(*) AS totalRows,
          COUNT(numeric_price) AS pricedCount,
          MIN(numeric_price) AS priceMin,
          MAX(numeric_price) AS priceMax,
          AVG(numeric_price) AS priceAverage
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
            ROW_NUMBER() OVER (ORDER BY numeric_price) AS rowNumber,
            COUNT(*) OVER () AS rowCount
          FROM priced_rows
          WHERE numeric_price IS NOT NULL
        )
        SELECT AVG(numeric_price) AS priceMedian
        FROM numbered
        WHERE rowNumber IN ((rowCount + 1) / 2, (rowCount + 2) / 2)
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
      return {
        sql: `
          SELECT bucket, COUNT(*) AS count
          FROM (
            SELECT
              CASE
                WHEN numeric_price >= ? THEN ?
                ELSE CAST((numeric_price - ?) / ? AS INTEGER)
              END AS bucket
            FROM (${pricedRowsSql}) priced_rows
            WHERE numeric_price IS NOT NULL
          ) bucketed
          GROUP BY bucket
          ORDER BY bucket ASC
        `,
        params: [max, binCount - 1, min, width, ...where.params],
        binCount,
        min,
        max,
        width,
      };
    },
  };
}

function buildListingsStatsQueries(options = {}) {
  if (looksLikeLiteKql(options.query || '')) {
    return buildLiteListingsStatsQueries(options);
  }
  const parsedQuery = parseQuery(options.query || '');
  const where = appendExcludeListingIds(buildWhereClause(parsedQuery), options.excludeListingIds);
  return buildStatsQueriesFromWhere(parsedQuery, where);
}

module.exports = {
  parseQuery,
  buildListingsQuery,
  buildListingIdsQuery,
  buildCountQuery,
  buildListingsStatsQueries,
  clampLimit,
};
