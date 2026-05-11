# Trading History CSV

The Tier 3 suggestion module can consume a personal trading-history CSV with `--history-csv`.

Files:

- Schema: `schemas/trading-history.schema.csv`
- Example: `examples/trading-history.example.csv`

## Row Model

Use one row per trade, skip, watch, or comparable. Keep raw notes short and put repeatable facts into normalized columns.

The highest-value fields are:

- `category`, `brand`, `model`, `variant`, `mount`
- `decision`, `outcome`
- `list_price_cad`, `purchase_price_cad`, `sold_price_cad`
- `realized_profit_cad`, `roi_percent`, `days_to_sell`
- `condition_grade`, `issue_flags`, `seller_risk_flags`
- `target_buy_price_cad`, `expected_sell_price_cad`, `expected_net_margin_cad`
- `demand_score`, `liquidity_score`, `identity_confidence_score`, `condition_risk_score`, `seller_risk_score`

## Current Consumption

`marketplace:home:tier3:dry-run` derives a scoring profile from the CSV:

- profitable or explicitly good rows become preferred categories and brands
- profitable row prices become category price bands
- `avoid_keywords` and bad-row `issue_flags` become avoid terms
- verdict reason codes show `using_csv_history_profile`

Run:

```bash
npm run marketplace:home:tier3:dry-run -- --history-csv examples/trading-history.example.csv --limit 5 --json
```

Use only one of `--history-csv` or `--history-profile`.

## Data Hygiene

Prefer hashed seller identifiers in `seller_name_hash`; do not store raw private names unless you intentionally want that local file to contain personal data. Keep prices in CAD numeric columns without currency symbols. Use pipe-separated lists for list fields such as `issue_flags`, `included_items`, `seller_risk_flags`, `avoid_keywords`, and `artifact_paths`.
