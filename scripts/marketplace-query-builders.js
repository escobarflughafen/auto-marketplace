const sqliteBuilders = require('./marketplace-homepage-query');
const postgresBuilders = require('./marketplace-homepage-query-postgres');

function normalizeMarketplaceSqlDialect(value) {
  const dialect = String(value || '').trim().toLowerCase();
  if (['postgres', 'postgresql', 'pg'].includes(dialect)) return 'postgres';
  return 'sqlite';
}

function getMarketplaceQueryBuilders(options = {}) {
  const dialect = normalizeMarketplaceSqlDialect(
    options.dialect
      || process.env.MARKETPLACE_DB_DIALECT
      || process.env.MARKETPLACE_SQL_DIALECT
      || '',
  );
  return dialect === 'postgres' ? postgresBuilders : sqliteBuilders;
}

module.exports = {
  normalizeMarketplaceSqlDialect,
  getMarketplaceQueryBuilders,
};
