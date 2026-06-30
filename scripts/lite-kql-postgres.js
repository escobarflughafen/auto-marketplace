const { resolveField } = require('./lite-kql-fields');
const { parseLiteKql, looksLikeLiteKql } = require('./lite-kql-parser');
const { planLiteKql, clampLimit } = require('./lite-kql-planner');
const { LiteKqlError } = require('./lite-kql-sqlite');
const { POSTGRES_LISTING_PRICE_SQL } = require('./postgres-price-sql');

function escapeLikeValue(value) {
  return String(value || '')
    .replace(/\\/g, '\\\\')
    .replace(/%/g, '\\%')
    .replace(/_/g, '\\_');
}

function createPlaceholderState() {
  let index = 0;
  return {
    next() {
      index += 1;
      return `$${index}`;
    },
  };
}

function sqlExpressionForField(field) {
  if (field.name === 'price') return POSTGRES_LISTING_PRICE_SQL;
  if (field.expression) return field.expression;
  if (field.column) return field.column;
  return null;
}

function valueForField(field, value) {
  const raw = value?.value ?? value;
  if (field.type === 'number') {
    const parsed = Number.parseFloat(String(raw).replace(/,/g, ''));
    return Number.isFinite(parsed) ? parsed : null;
  }
  return String(raw ?? '');
}

function textConditionForColumn(column, operator, value, placeholders) {
  const not = operator.startsWith('!') || operator === '!=';
  const positive = not ? 'NOT ILIKE' : 'ILIKE';
  const escaped = escapeLikeValue(value);
  let pattern = escaped;
  if (operator.includes('contains') || operator.includes('has') || operator === '=~' || operator === '!~') {
    pattern = `%${escaped}%`;
  } else if (operator.includes('startswith')) {
    pattern = `${escaped}%`;
  } else if (operator.includes('endswith')) {
    pattern = `%${escaped}`;
  }
  const placeholder = placeholders.next();
  if (operator === '==' || operator === '!=') {
    return {
      sql: `${column} ${operator === '!=' ? '!=' : '='} ${placeholder}`,
      params: [String(value)],
    };
  }
  return {
    sql: `${column} ${positive} ${placeholder} ESCAPE E'\\\\'`,
    params: [pattern],
  };
}

function textConditionForField(field, operator, value, placeholders) {
  const columns = field.columns || [field.column].filter(Boolean);
  const parts = columns.map((column) => textConditionForColumn(column, operator, value, placeholders));
  if (parts.length === 1) return parts[0];
  const joiner = operator.startsWith('!') || operator === '!=' ? ' AND ' : ' OR ';
  return {
    sql: parts.map((part) => `(${part.sql})`).join(joiner),
    params: parts.flatMap((part) => part.params),
  };
}

function compileCondition(node, placeholders) {
  if (!node) return null;
  if (node.type === 'term') {
    const value = `%${escapeLikeValue(node.value)}%`;
    const columns = [
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
    ];
    const params = [];
    const clauses = columns.map((column) => {
      params.push(value);
      return `${column} ILIKE ${placeholders.next()} ESCAPE E'\\\\'`;
    });
    return {
      sql: `(${clauses.join('\n        OR ')})`,
      params,
    };
  }
  if (node.type === 'not') {
    const child = compileCondition(node.child, placeholders);
    return child ? { sql: `NOT (${child.sql})`, params: child.params } : null;
  }
  if (node.type === 'and' || node.type === 'or') {
    const left = compileCondition(node.left, placeholders);
    const right = compileCondition(node.right, placeholders);
    if (!left) return right;
    if (!right) return left;
    return {
      sql: `(${left.sql}) ${node.type.toUpperCase()} (${right.sql})`,
      params: [...left.params, ...right.params],
    };
  }
  if (node.type !== 'condition' || node.invalid || !node.fieldMeta) return null;

  const field = node.fieldMeta;
  const operator = node.operator;
  const expression = sqlExpressionForField(field);
  if (operator === 'in' || operator === '!in') {
    const values = node.values.map((item) => valueForField(field, item)).filter((item) => item !== null && item !== '');
    if (!values.length) return null;
    if (field.type === 'text' && field.columns?.length) {
      const conditions = values.map((value) => textConditionForField(field, operator === '!in' ? '!=' : '==', value, placeholders));
      return {
        sql: conditions.map((condition) => `(${condition.sql})`).join(operator === '!in' ? ' AND ' : ' OR '),
        params: conditions.flatMap((condition) => condition.params),
      };
    }
    return {
      sql: `${expression} ${operator === '!in' ? 'NOT ' : ''}IN (${values.map(() => placeholders.next()).join(', ')})`,
      params: values,
    };
  }
  if (operator === 'between') {
    const first = valueForField(field, node.values[0]);
    const second = valueForField(field, node.values[1]);
    if (first === null || second === null) return null;
    return {
      sql: `(${expression}) BETWEEN ${placeholders.next()} AND ${placeholders.next()}`,
      params: [first, second],
    };
  }
  if (field.type === 'number') {
    const value = valueForField(field, node.values[0]);
    if (value === null) return null;
    return {
      sql: `(${expression}) ${operator === '==' ? '=' : operator} ${placeholders.next()}`,
      params: [value],
    };
  }
  if (field.type === 'date' && ['<', '<=', '>', '>=', '==', '!='].includes(operator)) {
    return {
      sql: `${expression} ${operator === '==' ? '=' : operator} ${placeholders.next()}`,
      params: [valueForField(field, node.values[0])],
    };
  }
  return textConditionForField(field, operator, valueForField(field, node.values[0]), placeholders);
}

function whereFromPlan(plan, excludeListingIds = [], placeholders = createPlaceholderState()) {
  const clauses = [];
  const params = [];
  const condition = compileCondition(plan.expression, placeholders);
  if (condition) {
    clauses.push(condition.sql);
    params.push(...condition.params);
  }
  const ids = [...new Set((Array.isArray(excludeListingIds) ? excludeListingIds : [excludeListingIds])
    .flatMap((item) => String(item || '').split(','))
    .map((item) => item.trim())
    .filter(Boolean))];
  if (ids.length) {
    clauses.push(`listing_id NOT IN (${ids.map(() => placeholders.next()).join(', ')})`);
    params.push(...ids);
  }
  return {
    sql: clauses.length ? `WHERE ${clauses.join(' AND ')}` : '',
    params,
    placeholders,
  };
}

function orderByFromPlan(plan, override = {}) {
  const sortField = override.sort
    ? resolveField(plan.source, override.sort)
    : resolveField(plan.source, plan.sort?.field);
  const direction = String(override.sortDirection || plan.sort?.direction || 'desc').toLowerCase() === 'asc' ? 'ASC' : 'DESC';
  const fieldName = sortField?.name || 'last_seen_at';
  if (fieldName === 'price') return `ORDER BY ${POSTGRES_LISTING_PRICE_SQL} ${direction} NULLS LAST, last_seen_at DESC`;
  if (fieldName === 'rank') return `ORDER BY COALESCE(last_seen_rank, 999999) ${direction}, last_seen_at DESC`;
  if (fieldName === 'title') return `ORDER BY LOWER(COALESCE(NULLIF(detail_title, ''), NULLIF(card_title, ''), '')) ${direction}, last_seen_at DESC`;
  if (fieldName === 'seller') return `ORDER BY LOWER(COALESCE(NULLIF(detail_seller_name, ''), '')) ${direction}, last_seen_at DESC`;
  if (fieldName === 'condition') return `ORDER BY LOWER(COALESCE(NULLIF(detail_condition, ''), '')) ${direction}, last_seen_at DESC`;
  if (fieldName === 'location') return `ORDER BY LOWER(COALESCE(NULLIF(detail_location, ''), '')) ${direction}, last_seen_at DESC`;
  return `ORDER BY ${sortField?.column || 'last_seen_at'} ${direction}, first_seen_at ${direction}`;
}

function ensurePlan(query, options = {}) {
  const ast = parseLiteKql(query, { source: options.source || 'listings' });
  const plan = planLiteKql(ast, options);
  const errors = plan.diagnostics.filter((item) => item.severity !== 'warning');
  if (errors.length) {
    throw new LiteKqlError(errors[0].message, plan.diagnostics);
  }
  if (plan.source !== 'listings') {
    throw new LiteKqlError(`Source "${plan.source}" cannot be queried from listings endpoint.`, plan.diagnostics);
  }
  return plan;
}

function buildLiteListingsQuery(options = {}) {
  const plan = ensurePlan(options.query || '', options);
  const placeholders = createPlaceholderState();
  const where = whereFromPlan(plan, options.excludeListingIds, placeholders);
  const limit = clampLimit(plan.limit || options.limit);
  const offset = Math.max(0, Number.parseInt(plan.offset ?? options.offset, 10) || 0);
  return {
    parsedQuery: {
      mode: 'lite-kql',
      dialect: 'postgres',
      source: plan.source,
      ast: plan.ast,
      plan,
      diagnostics: plan.diagnostics,
      warnings: plan.warnings,
      sort: plan.sort?.field || 'last_seen_at',
      sortDirection: plan.sort?.direction || 'desc',
    },
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
        ${POSTGRES_LISTING_PRICE_SQL} AS numeric_price
      FROM homepage_listings
      ${where.sql}
      ${orderByFromPlan(plan, options)}
      LIMIT ${placeholders.next()} OFFSET ${placeholders.next()}
    `,
    params: [...where.params, limit, offset],
    limit,
    offset,
  };
}

function buildLiteListingIdsQuery(options = {}) {
  const plan = ensurePlan(options.query || '', options);
  const placeholders = createPlaceholderState();
  const where = whereFromPlan(plan, options.excludeListingIds, placeholders);
  const extra = options.backlogOnly === false ? '' : "detail_status IN ('pending', 'error', 'processing')";
  const whereSql = [where.sql.replace(/^WHERE\s+/i, ''), extra].filter(Boolean).join(' AND ');
  return {
    parsedQuery: { mode: 'lite-kql', dialect: 'postgres', source: plan.source, plan, diagnostics: plan.diagnostics, warnings: plan.warnings },
    sql: `
      SELECT listing_id
      FROM homepage_listings
      ${whereSql ? `WHERE ${whereSql}` : ''}
      ${orderByFromPlan(plan, options)}
    `,
    params: where.params,
  };
}

function buildLiteCountQuery(options = {}) {
  const plan = ensurePlan(options.query || '', options);
  const placeholders = createPlaceholderState();
  const where = whereFromPlan(plan, options.excludeListingIds, placeholders);
  return {
    parsedQuery: { mode: 'lite-kql', dialect: 'postgres', source: plan.source, plan, diagnostics: plan.diagnostics, warnings: plan.warnings },
    sql: `
      SELECT COUNT(*) AS total
      FROM homepage_listings
      ${where.sql}
    `,
    params: where.params,
  };
}

function statsQueriesFromWhere(parsedQuery, where, placeholders) {
  const pricedRowsSql = `
    SELECT ${POSTGRES_LISTING_PRICE_SQL} AS numeric_price
    FROM homepage_listings
    ${where.sql}
  `;
  return {
    parsedQuery,
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
      const histogramWhere = whereFromPlan(where.plan, where.excludeListingIds, histogramPlaceholders);
      const maxPlaceholder = histogramPlaceholders.next();
      const binPlaceholder = histogramPlaceholders.next();
      const minPlaceholder = histogramPlaceholders.next();
      const widthPlaceholder = histogramPlaceholders.next();
      const histogramPricedRowsSql = `
        SELECT ${POSTGRES_LISTING_PRICE_SQL} AS numeric_price
        FROM homepage_listings
        ${histogramWhere.sql}
      `;
      return {
        sql: `
          SELECT bucket, COUNT(*) AS count
          FROM (
            SELECT
              CASE
                WHEN numeric_price >= ${maxPlaceholder} THEN ${binPlaceholder}
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

function buildLiteListingsStatsQueries(options = {}) {
  const plan = ensurePlan(options.query || '', options);
  const placeholders = createPlaceholderState();
  const where = whereFromPlan(plan, options.excludeListingIds, placeholders);
  return statsQueriesFromWhere(
    { mode: 'lite-kql', dialect: 'postgres', source: plan.source, plan, diagnostics: plan.diagnostics, warnings: plan.warnings },
    { ...where, plan, excludeListingIds: options.excludeListingIds },
    placeholders,
  );
}

module.exports = {
  LiteKqlError,
  POSTGRES_LISTING_PRICE_SQL,
  looksLikeLiteKql,
  buildLiteListingsQuery,
  buildLiteListingIdsQuery,
  buildLiteCountQuery,
  buildLiteListingsStatsQueries,
};
