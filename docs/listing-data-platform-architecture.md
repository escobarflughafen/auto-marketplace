# Listing Data Platform Architecture

## Goal

Build a listing collection platform that can ingest data from many listing sources, not just Facebook Marketplace. The system should support runtime-injected collectors, durable streaming, replayable raw data, interpretable product labeling, fast analytics, full-text search, and high availability.

The core rule is:

> Collectors are source-specific and replaceable. Events are durable. Labels are versioned. Canonical listing identity is source-independent.

## Current Problem

The current collector has useful raw homepage data, but several fields are overloaded:

- `source_keyword` is provenance, not a reliable product label.
- Facebook-specific card structure leaks into downstream analysis.
- SQLite is useful for local iteration, but it is not enough for streaming, replay, high availability, or cross-source deduplication.
- Labels improve over time, so the system needs replay and label versioning.

The next platform should separate:

- collection
- parsing
- normalization
- labeling
- deduplication
- search
- analytics

## Target Architecture

```text
runtime collector plugin
  -> raw event stream
  -> immutable raw archive
  -> parser / normalizer workers
  -> labeler workers
  -> identity resolver
  -> analytics sink
  -> search sink
  -> dashboards / alerts / APIs
```

Recommended stack:

- Streaming: Redpanda or Kafka
- Raw archive: S3-compatible object storage
- Analytics: ClickHouse
- Search: OpenSearch or Elasticsearch
- Operational state: Postgres
- Dashboards: Grafana, Metabase, Kibana, or OpenSearch Dashboards
- Worker runtime: Node.js workers or containerized workers

## Runtime Collector Interface

Each source should implement a common collector contract.

```ts
export interface ListingCollector {
  sourceId: string;
  version: string;

  discover(config: SourceConfig): AsyncIterable<RawListingEvent>;
  parse(raw: RawListingEvent): ParsedListingEvent;
  normalize(parsed: ParsedListingEvent): CanonicalListingEvent;
}
```

Example collectors:

```text
collectors/
  facebook_marketplace/
    collector.ts
    parser.ts
    manifest.json
  craigslist/
    collector.ts
    parser.ts
    manifest.json
  kijiji/
    collector.ts
    parser.ts
    manifest.json
  ebay/
    collector.ts
    parser.ts
    manifest.json
```

Collectors should be injected at runtime by a runner. The runner should load a collector based on source id, version, and job config.

Example job config:

```json
{
  "source": "facebook_marketplace",
  "collector": "facebook_marketplace@3.1.0",
  "entrypoint": "search",
  "query": "canon 85 1.4",
  "region": "vancouver",
  "max_pages": 20
}
```

## Collector Manifest

Each collector should declare capabilities and constraints in a manifest.

```json
{
  "source_id": "facebook_marketplace",
  "version": "3.1.0",
  "supported_entrypoints": ["homepage", "search", "detail"],
  "requires_auth": true,
  "rate_limits": {
    "requests_per_minute": 20,
    "concurrency": 2
  },
  "capabilities": {
    "pagination": true,
    "detail_fetch": true,
    "geo": true,
    "screenshots": true
  },
  "schemas": {
    "raw_event": "raw_listing_event.v1",
    "parsed_event": "parsed_listing_event.v1",
    "canonical_event": "canonical_listing_event.v1"
  }
}
```

## Canonical Event Envelope

Every collector should emit events using a shared envelope. Source-specific details stay in `raw` and `evidence`; downstream systems rely on `parsed` and `normalized`.

```json
{
  "event_id": "uuid",
  "event_type": "listing_observed",
  "schema_version": "listing_event.v1",
  "source_id": "facebook_marketplace",
  "collector_version": "3.1.0",
  "run_id": "uuid",
  "observed_at": "2026-05-01T08:19:01Z",
  "source_listing_id": "26382679951340196",
  "url": "https://www.facebook.com/marketplace/item/26382679951340196/",
  "raw": {
    "card_text": "CA$ 1,000 | Canon EF - 85mm L is f1.4 | BCDelta"
  },
  "parsed": {
    "title": "Canon EF - 85mm L is f1.4",
    "price_text": "CA$ 1,000",
    "location_text": "BCDelta",
    "rank": 12
  },
  "normalized": {
    "price": 1000,
    "currency": "CAD",
    "region": "BC",
    "city": "Delta"
  },
  "evidence": {
    "query": "canon 85 1.4",
    "page_type": "search_results",
    "source_keyword": "canon 85 1.4",
    "selector_version": "fb_search_v3"
  }
}
```

## Event Topics

Recommended stream topics:

- `listing.raw_observed`
- `listing.parsed`
- `listing.normalized`
- `listing.labeled`
- `listing.identity_resolved`
- `listing.detail_fetched`
- `listing.failed`
- `listing.dead_letter`

Each event should be immutable. Corrections should be emitted as new events with a new schema or label version.

## Raw Archive

All raw events should be written to object storage before or during stream ingestion.

Recommended layout:

```text
s3://listing-archive/raw/source_id=facebook_marketplace/date=2026-05-01/hour=08/*.jsonl.zst
s3://listing-archive/parsed/source_id=facebook_marketplace/date=2026-05-01/hour=08/*.parquet
s3://listing-archive/screenshots/source_id=facebook_marketplace/date=2026-05-01/*.png
```

This gives the system:

- replay
- auditability
- re-labeling
- historical debugging
- cheaper long-term retention

## Labeling Model

Labels should be separate from source provenance.

Fields:

- `label_stage`
- `label_method`
- `label_version`
- `label_confidence`
- `category_guess`
- `subcategory_guess`
- `brand_guess`
- `product_family_guess`
- `normalized_model_guess`
- `evidence_json`

Example:

```json
{
  "label_stage": "collection_guess",
  "label_method": "heuristic",
  "label_version": "camera_lens_v1",
  "label_confidence": 0.92,
  "category_guess": "electronics",
  "subcategory_guess": "camera_lens",
  "brand_guess": "Canon",
  "product_family_guess": "EF 85mm",
  "normalized_model_guess": "Canon EF 85mm f/1.4L IS USM",
  "evidence_json": {
    "positive": ["canon", "85mm", "f1.4", "ef"],
    "negative": [],
    "source_keyword": "canon 85 1.4"
  }
}
```

Use at least two labeling stages:

- `collection_guess`: fast, conservative, based on listing card data
- `detail_confirmed`: stronger label after detail page enrichment

## Tiered Collector And Escalation Playbook

The collector should behave like a staged decision system rather than a single scraper. Each level spends more compute and attention only on listings that are worth it.

```text
L0 collector
  -> L1 classifier
  -> L2 verifier
  -> L3 human escalation
```

### L0: Broad Discovery

Goal: collect broadly and cheaply.

Responsibilities:

- scan source pages
- capture raw card data
- store source keyword and page provenance
- emit `listing.raw_observed`
- avoid expensive detail-page visits unless a listing passes L1

Output:

- raw title
- raw price text
- raw location text
- listing URL
- source keyword
- rank
- first seen and last seen timestamps

### L1: Candidate Classifier

Goal: normalize and score whether a listing deserves detail-page verification.

Responsibilities:

- parse price, location, brand, model, mount, focal length, and aperture
- assign product family
- estimate market price band from historical observations
- compare against personal buy/sell records when available
- calculate early opportunity score

L1 should promote a listing to L2 when:

- model confidence is moderate or high
- asking price is below the observed market band
- expected resale value is high enough to justify inspection
- listing is fresh or highly ranked
- the item belongs to a watchlist family

Example L1 output:

```json
{
  "decision": "promote_to_l2",
  "model_guess": "Nikon AF-S 85mm f/1.4G",
  "confidence": 0.78,
  "ask_price": 650,
  "market_median": 925,
  "expected_margin": 180,
  "reasons": ["below observed floor", "watchlist product", "fresh listing"]
}
```

### L2: Detail Verifier

Goal: open the detail page, verify authenticity and risk, then decide whether to escalate to the user.

Responsibilities:

- visit the detail page
- capture full title, description, price, seller info, location, photos, and condition fields
- verify the exact model and mount
- detect condition warnings
- detect scam or seller-risk signals
- detect bundle value
- estimate net margin after fees, travel, tax, shipping, and repair risk
- decide `escalate`, `watch`, or `skip`

L2 should inspect:

- exact model text
- image evidence, including front element, rear element, mount, serial plate, box, hood, caps, and included accessories
- description quality
- seller profile signals
- listing age
- price changes
- location friction
- shipping or pickup constraints

### L2 Escalation Indicators

L2 should escalate to the user when the listing has a strong combination of margin, confidence, and acceptable risk.

Primary indicators:

- `expected_net_margin`: projected profit after all costs
- `model_identity_confidence`: confidence that the listing is the intended model
- `condition_risk`: likelihood of fungus, haze, scratches, broken autofocus, impact damage, or missing parts
- `sell_through_speed`: expected resale time based on personal trade history
- `seller_risk`: scam, copied text, suspicious profile, deposit pressure, shipping-only behavior, or inconsistent details
- `listing_freshness`: newly listed, high rank, or recently updated
- `location_friction`: travel time, pickup complexity, or shipping friction

Secondary indicators:

- price below observed clean-market floor
- bundle value from hood, caps, box, filters, tripod collar, pouch, or adapter
- rare model or known fast-moving model
- exact match to a personal watchlist
- recent successful resale history for the same model
- seller appears responsive and local

### L2 Non-Escalation Indicators

L2 should avoid escalating when:

- product identity is ambiguous
- mount or version is unclear
- the listing is actually a third-party lens when the target is first-party
- price is only average
- expected profit is small after travel, fees, tax, or repair risk
- photos or description suggest damage
- title includes `for parts`, `as-is`, `broken`, `repair`, `fungus`, `haze`, or `not tested`
- seller behavior looks risky
- model has slow sell-through in personal records

### Decision Scores

Start with conservative thresholds:

- `escalate`: score `>= 80`
- `watch`: score `60-79`
- `skip`: score `< 60`

Example score components:

- `+25`: price below clean market floor
- `+20`: strong expected net margin
- `+15`: high model identity confidence
- `+10`: fast sell-through from personal records
- `+10`: fresh listing
- `+10`: nearby or easy pickup
- `+10`: valuable extras included
- `-15`: mount or version uncertainty
- `-20`: vague title or weak photos
- `-20`: slow sell-through
- `-25`: condition red flags
- `-30`: scam or seller-risk signals

The score should be explainable. Store every positive and negative reason in `decision_evidence_json`.

### L2 Decision Card

Every L2-reviewed candidate should produce a compact decision card.

```text
Decision: escalate
Model: Nikon AF-S 85mm f/1.4G
Ask: CA$650
Market floor: CA$800
Expected resale: CA$950-1,050
Expected net margin: CA$220-300
Confidence: 0.86
Risk: medium
Reasons:
- exact model likely from title and detail text
- ask is below observed clean-market floor
- fresh listing
- needs glass condition confirmation from photos
```

### Human Alert Policy

The system should alert the user only when:

- expected net margin is above the configured threshold
- model identity confidence is high enough
- condition and seller risk are acceptable
- the item is fresh or competitive enough that delay matters

Recommended default thresholds:

- minimum expected net margin: `CA$150`
- minimum expected margin percentage: `20%`
- minimum model confidence: `0.80`
- maximum condition risk: `medium`
- maximum seller risk: `medium`

Cheap but ambiguous listings should go to `watch`, not direct alert.

### Personal Trade Records

Personal buy/sell history should feed the L1 and L2 decision engine.

Suggested table:

```text
personal_trades
  id
  normalized_model
  brand
  mount
  focal_length
  aperture
  buy_price
  sold_price
  fees
  shipping_cost
  tax
  repair_cost
  travel_cost
  net_profit
  days_to_sell
  condition
  included_items_json
  bought_source
  sold_platform
  bought_at
  sold_at
  notes
```

Use this data to calculate:

- expected resale price
- expected net margin
- expected days to sell
- historical win rate by model
- minimum buy price threshold
- maximum acceptable risk

The best alerts should combine market observations with personal outcomes:

```text
Canon EF 85mm f/1.4L IS
Ask: CA$1,000
Historical net resale median: CA$1,350
Expected net margin: CA$250-300
Decision: inspect / buy if clean
Confidence: 0.82
```

## Product Labeling Rules

Rules should be product-family based, not raw keyword based.

Example for camera lenses:

- Positive evidence: `canon`, `ef`, `85mm`, `f1.4`
- Negative evidence: `sigma`, `tamron`, `rokinon`, `viltrox`, `adapter`, `cap`, `filter`, `kit`
- Conflict handling: if title contains `Sigma 85mm f/1.4 for Canon`, label brand as `Sigma`, mount as `Canon EF`, and do not label it as a Canon lens.

Store conflicts and evidence, not just the final label.

## Identity Resolution

Each source has its own listing id. The platform should also maintain a source-independent canonical listing id.

```text
source_listing_id -> canonical_listing_id
```

Signals for matching:

- normalized title
- normalized price
- source region and city
- seller identity if available
- image hash
- model/product label
- listing age
- phone/email when available
- URL canonicalization

Tables:

- `source_listings`
- `canonical_listings`
- `listing_identity_links`
- `identity_resolution_evidence`

This prevents double counting when the same item appears on multiple listing sites.

## Storage Model

### Postgres

Use Postgres for operational state:

- collector jobs
- source configs
- plugin registry
- worker leases
- credentials references
- run status
- canonical listing current state if transactional updates are needed

### ClickHouse

Use ClickHouse for analytics:

- price distributions
- keyword precision
- source quality
- regional inventory
- visibility duration
- rank movement
- deal scoring
- daily aggregates

Suggested tables:

- `listing_observations`
- `listing_labels`
- `price_observations`
- `keyword_evidence`
- `source_runs`
- `listing_visibility_daily`
- `family_price_distribution_daily`
- `keyword_precision_daily`

### OpenSearch / Elasticsearch

Use OpenSearch or Elasticsearch for search and exploration:

- full-text listing search
- faceted filters
- fuzzy matching
- current listing UI
- analyst workflows

Index examples:

- `listings-current`
- `listing-observations-*`
- `listing-labels-*`

Do not use the search index as the only source of truth.

## High Availability

Minimum HA shape:

- 3 broker nodes across availability zones
- replicated object storage
- 2 or more collector runner replicas
- 2 or more parser/normalizer worker replicas
- 2 or more labeler worker replicas
- ClickHouse replicated cluster or managed ClickHouse
- OpenSearch/Elasticsearch multi-node cluster
- Postgres managed HA or primary/replica setup
- dead-letter queues for malformed events
- idempotent event producers
- replay from object storage

Collector workers should be stateless except for browser session references and short-lived local cache.

## Runtime Injection Safety

Runtime-injected collectors need isolation.

Requirements:

- run collectors in separate worker processes or containers
- enforce CPU, memory, and timeout limits
- validate emitted events with JSON schema
- pin collector versions per run
- store credentials outside plugin code
- restrict filesystem and network access where practical
- emit collector health metrics
- send malformed events to `listing.dead_letter`

## Observability

Track:

- rows collected per source and query
- parse success rate
- label confidence distribution
- detail fetch success rate
- duplicate rate
- dead-letter rate
- average collection latency
- event lag by topic
- ClickHouse ingestion lag
- OpenSearch indexing lag
- per-keyword precision

Key dashboards:

- Source health
- Pipeline lag
- Label quality
- Keyword precision
- Deal candidates
- Region inventory
- Price distribution by family

## Migration Plan

### Phase 1: Wrap Existing Collector

- Keep current SQLite writes.
- Add event emission from the existing Facebook collector.
- Create `facebook_marketplace` plugin manifest.
- Emit `listing.raw_observed` events.

### Phase 2: Add Archive And Stream

- Add Redpanda or Kafka.
- Write raw events to object storage.
- Add dead-letter topic.
- Add schema validation.

### Phase 3: Normalize And Label

- Add parser/normalizer worker.
- Add labeler worker.
- Version label rules.
- Backfill labels from existing SQLite data.

### Phase 4: Analytics Sink

- Add ClickHouse.
- Create observation, label, keyword evidence, and aggregate tables.
- Rebuild current reports from ClickHouse instead of ad hoc SQLite scripts.

### Phase 5: Search Sink

- Add OpenSearch or Elasticsearch.
- Index current canonical listings.
- Build faceted search around source, region, price, brand, family, and label confidence.

### Phase 6: Add Second Source

- Implement a second collector plugin, such as Craigslist or Kijiji.
- Validate that the canonical event model works outside Facebook.
- Add cross-source deduplication.

### Phase 7: Production Hardening

- Add HA deployment.
- Add worker autoscaling.
- Add replay jobs.
- Add source-specific rate limits.
- Add run-level audit logs.

## Recommended First Implementation

Start with:

- Redpanda for streaming
- S3-compatible storage for raw events
- ClickHouse for analytics
- OpenSearch only after search UX is needed
- Postgres for configs and job state

The first milestone should be small:

1. Define canonical event schemas.
2. Wrap the current Facebook collector as a plugin.
3. Emit raw and parsed events.
4. Store raw events in object storage.
5. Sink normalized events into ClickHouse.
6. Rebuild the current keyword and price reports from ClickHouse.

This gives immediate value without forcing the whole platform to be rebuilt at once.

## Work Plan And Milestones

### Milestone 1: Canonical Event Contract

Goal: make the current collector emit source-agnostic listing events while preserving existing SQLite behavior.

Deliverables:

- `RawListingEvent`, `ParsedListingEvent`, and `CanonicalListingEvent` schemas
- JSON schema validation for emitted events
- `run_id`, `source_id`, `collector_version`, and `schema_version` on every event
- event fixture tests based on current Facebook Marketplace rows

Acceptance criteria:

- current Facebook collector can emit valid raw events
- malformed events are rejected before entering the stream
- SQLite output remains unchanged during migration

### Milestone 2: Runtime Collector Plugin Wrapper

Goal: wrap the current Facebook Marketplace collector behind a runtime-loaded plugin interface.

Deliverables:

- collector manifest format
- runtime collector loader
- `facebook_marketplace` plugin
- source config model
- collector run records in Postgres or the existing local DB during development

Acceptance criteria:

- a collection run can be started from a config object
- the runner does not depend on Facebook-specific parser internals
- collector version and source config are recorded for every event

### Milestone 3: Durable Stream And Raw Archive

Goal: make collection replayable and recoverable.

Deliverables:

- Redpanda or Kafka topic setup
- `listing.raw_observed` topic
- object storage writer for raw JSONL or Parquet
- dead-letter topic for schema failures
- basic event lag and failure metrics

Acceptance criteria:

- raw events are written to both stream and archive
- a failed parser can be replayed from object storage
- dead-letter events include enough context to debug the source row

### Milestone 4: Parser, Normalizer, And Labeler Workers

Goal: turn source-specific observations into interpretable product data.

Deliverables:

- parser worker
- normalizer worker
- heuristic labeler worker
- `label_version` and `label_confidence`
- product-family rules for camera and lens listings
- keyword evidence table

Acceptance criteria:

- `source_keyword` is stored as provenance only
- product labels are separate, versioned, and auditable
- the Canon/Nikon lens reports can be rebuilt from normalized labels

### Milestone 5: ClickHouse Analytics Sink

Goal: move reporting from ad hoc SQLite scans to a scalable analytics layer.

Deliverables:

- ClickHouse schema for observations, labels, prices, keywords, and runs
- stream sink into ClickHouse
- daily aggregate tables
- reports for keyword precision, price distribution, and region inventory

Acceptance criteria:

- current stats reports run from ClickHouse
- historical distributions can be queried by source, region, family, and label version
- outlier prices can be filtered without losing raw observations

### Milestone 6: Search Sink

Goal: support fast exploration and faceted search.

Deliverables:

- OpenSearch or Elasticsearch index for current listings
- index mapping for title, normalized fields, source, region, and price
- full-text and faceted query API
- current listing search dashboard

Acceptance criteria:

- searches like `Canon RF 85 Ottawa` return current normalized listings
- facets include source, region, brand, family, aperture bucket, and price range
- search results link back to canonical listing records and raw evidence

### Milestone 7: Second Source Plugin

Goal: prove the collector model works outside Facebook Marketplace.

Deliverables:

- second source plugin, such as Craigslist, Kijiji, or eBay
- source-specific parser
- shared canonical event output
- source-level precision and coverage report

Acceptance criteria:

- both Facebook and the second source emit the same canonical event type
- analytics and search require no source-specific branching
- cross-source rows can be compared by normalized product family

### Milestone 8: Cross-Source Identity Resolution

Goal: prevent duplicate inventory counts across listing sites.

Deliverables:

- canonical listing id model
- source listing to canonical listing links
- identity resolution worker
- evidence table for matching signals
- duplicate/conflict reports

Acceptance criteria:

- probable duplicates across sources are grouped
- analysts can inspect why two source listings were linked
- inventory reports can switch between source listing count and canonical listing count

### Milestone 9: Production Hardening

Goal: make the system highly available and operable.

Deliverables:

- replicated stream cluster
- replicated ClickHouse or managed ClickHouse
- multi-node OpenSearch or Elasticsearch
- HA Postgres or managed Postgres
- worker autoscaling
- rate-limit controls per source
- run-level audit logs
- replay tooling

Acceptance criteria:

- workers can restart without data loss
- lag and failures are visible from dashboards
- archived events can rebuild ClickHouse and search indexes
- collectors can be disabled or rolled back per source and version
