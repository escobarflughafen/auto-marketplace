# Facebook Marketplace URL Parameter Findings

This note records findings from a web interaction observer session against Facebook Marketplace.

Session artifact:

```text
artifacts/web-observations/fb-marketplace-observer-2026-06-14T21-40-55-022Z/
```

Session label:

```text
Reading camera listings, setting query parameters, and discovering the rental market with parameters set
```

The artifact is local runtime data and is intentionally ignored by git. Treat it as trusted-local only because early screenshots may include authentication UI. JSON and Markdown records were sanitized after the recording.

## High-Level Finding

Marketplace search state is strongly represented in URL path segments and query parameters. For many worker use cases, it is more efficient and less brittle to construct a target URL directly than to replay every filter click.

This is especially useful for collector/search workers:

1. Build a Marketplace URL from structured worker parameters.
2. Navigate directly to the URL.
3. Wait for Marketplace results.
4. Collect cards/listings from the resulting page.
5. Fall back to UI interaction only when direct navigation does not produce the expected state.

## Observed URL Shapes

General item search:

```text
/marketplace/{area}/search/?query={query}
/marketplace/{area}/search?query={query}&exact=false
/marketplace/{area}/search?query={query}&minPrice={min}&maxPrice={max}&exact=false
```

Rental category:

```text
/marketplace/{area}/propertyrentals
/marketplace/{area}/propertyrentals?maxPrice={max}&exact=false&latitude={lat}&longitude={lng}&radius={radius}
```

Item detail from search results:

```text
/marketplace/item/{listing_id}/?ref=search&...
```

Item detail from category feed:

```text
/marketplace/item/{listing_id}?ref=category_feed&...
```

## Observed Parameters

| Parameter | Observed Meaning | Example |
| --- | --- | --- |
| `query` | Keyword search text | `nikkor 14-24` |
| `minPrice` | Minimum price filter | `600` |
| `maxPrice` | Maximum price filter | `2000` |
| `daysSinceListed` | Recency filter | `30` |
| `itemCondition` | Comma-separated condition values | `new,used_like_new` |
| `exact` | Search matching/location behavior flag; observed as `false` after filter interactions | `false` |
| `latitude` | Location center latitude for category/rental browsing | `49.2436` |
| `longitude` | Location center longitude for category/rental browsing | `-123.0571` |
| `radius` | Marketplace location radius/internal distance value | `14` |

## Observed State Transitions

Camera/lens search flow:

```text
/marketplace/vancouver/search/?query=nikkor%2014-24
/marketplace/vancouver/search?daysSinceListed=30&query=nikkor%2014-24&exact=false
/marketplace/vancouver/search?itemCondition=new%2Cused_like_new&query=nikkor%2014-24&exact=false
/marketplace/vancouver/search?minPrice=600&maxPrice=2000&query=nikkor%2014-24&exact=false
```

Rental discovery flow:

```text
/marketplace/vancouver/propertyrentals
/marketplace/vancouver/propertyrentals?exact=false&latitude=49.2517&longitude=-123.0714&radius=105
/marketplace/vancouver/propertyrentals?maxPrice=2000&exact=false&latitude=49.2436&longitude=-123.0571&radius=14
```

## Worker Implications

The search explorer should support URL construction for known parameter sets:

```text
area
query
minPrice
maxPrice
daysSinceListed
itemCondition
categoryPath
latitude
longitude
radius
exact
```

For generic item search:

```text
https://www.facebook.com/marketplace/{area}/search?query={query}&minPrice={min}&maxPrice={max}&exact=false
```

For rentals:

```text
https://www.facebook.com/marketplace/{area}/propertyrentals?maxPrice={max}&exact=false&latitude={lat}&longitude={lng}&radius={radius}
```

The worker should still verify page state after navigation:

- URL path matches expected area/category.
- Search box or page text reflects the keyword when relevant.
- Results are visible.
- Empty/error/login/checkpoint states are detected.
- The final URL is captured in worker events.

## Recommended Next Step

Add a URL builder module for Marketplace search targets, with unit tests for:

- generic keyword search;
- min/max price filters;
- condition filters;
- listed-date filters;
- rental category with location coordinates and radius;
- preservation/removal of unsupported empty params.

Then update collector/search workers to prefer direct URL navigation before falling back to UI filter interaction.
