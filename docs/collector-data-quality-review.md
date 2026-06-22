# Collector Data Quality Review

Date: 2026-06-22

## Context

The recorded Facebook Marketplace observation showed that a useful collector run can extract more than a listing URL and card text. The page state is also represented in URL parameters such as `query`, `minPrice`, `maxPrice`, `daysSinceListed`, `itemCondition`, `latitude`, `longitude`, and `radius`, and the visible listing cards expose product images in the DOM before any detail page is opened.

## Current Collector Output

The homepage and search collectors persist these listing-level fields:

- listing id and canonical Marketplace URL
- card title and card text
- visible rank in the scan window
- source mode and source keyword
- first seen and last seen timestamps
- raw card JSON for auditing
- associated card photos from visible listing images

Resolvers add richer detail fields later:

- resolved title, description, seller/location/detail text, and availability
- screenshot and DOM snapshot artifacts
- optional listing thumbnails captured on the detail page
- detail lifecycle events and content hashes

## Latest Change

Card image extraction now runs in the same collector pass that reads listing anchors. The collector looks around the listing anchor, reads visible `img` elements, de-duplicates by image URL, and stores up to four images per card.

Listing media is normalized into `listing_media`:

- `listing_id`
- `media_key`
- `media_type`
- `source`
- `source_url`
- `artifact_path`
- `alt_text`
- `width`
- `height`
- `position`
- `first_seen_at`
- `last_seen_at`
- `metadata_json`

The resolver also writes captured detail thumbnails into the same table, so UI and recommendation code can treat card photos and resolved detail photos consistently.

## Data Quality Gaps

- Card text can still mix title, price, freshness, location, and seller snippets depending on the Marketplace card layout.
- The collector should avoid loading detail pages during broad scans; detail extraction belongs to resolver workers.
- Price and location parsing should be measured as a quality signal rather than assumed to be available for every card.
- Rental-specific fields were visible in the recorded session, but rental support is intentionally out of scope for the current collector behavior.

## Recommended Next Refinements

- Add cycle-level quality metrics: listings with photos, parsed price, parsed title, parsed location, and low-confidence title.
- Store primary media selection for display, derived from `listing_media` by source and position.
- Add a lightweight media API for listing details so UI components do not parse `raw_card_json`.
- Reuse the recorded URL parameter model to keep search collector filters explicit and testable.
- Add sampled DOM fixtures from recorded sessions for collector extraction tests.
