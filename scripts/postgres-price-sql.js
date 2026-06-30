function firstPriceTokenExpression(textSql) {
  const priceTail = `
    CASE
      WHEN ${textSql} LIKE '%CA$%' THEN SUBSTRING(${textSql} FROM POSITION('CA$' IN ${textSql}) + 3)
      WHEN ${textSql} LIKE '%$%' THEN SUBSTRING(${textSql} FROM POSITION('$' IN ${textSql}) + 1)
      ELSE ''
    END
  `;
  const normalizedTail = `
    BTRIM(REPLACE(REPLACE(REPLACE(REPLACE(REPLACE((${priceTail}), ',', ''), '|', ' '), '。', ' '), '，', ' '), ':', ' '))
  `;
  return `
    CASE
      WHEN POSITION(' ' IN (${normalizedTail})) > 0
        THEN SUBSTRING((${normalizedTail}) FROM 1 FOR POSITION(' ' IN (${normalizedTail})) - 1)
      ELSE (${normalizedTail})
    END
  `;
}

function sqliteIntegerCastExpression(textSql) {
  return `
    CASE
      WHEN NULLIF((${textSql}), '') IS NULL
        THEN NULL
      ELSE COALESCE(
        NULLIF(REPLACE((regexp_match((${textSql}), '^\\s*([+-]?\\d+)'))[1], ',', ''), '')::BIGINT,
        0
      )
    END
  `;
}

function buildPostgresListingPriceSql() {
  return `
    COALESCE(
      ${sqliteIntegerCastExpression("REPLACE(REPLACE(REPLACE(detail_price, 'CA$', ''), '$', ''), ',', '')")},
      ${sqliteIntegerCastExpression(firstPriceTokenExpression('detail_price'))},
      ${sqliteIntegerCastExpression(firstPriceTokenExpression('card_text'))}
    )
  `;
}

const POSTGRES_LISTING_PRICE_SQL = buildPostgresListingPriceSql();

module.exports = {
  POSTGRES_LISTING_PRICE_SQL,
  buildPostgresListingPriceSql,
  firstPriceTokenExpression,
  sqliteIntegerCastExpression,
};
