# Marketplace Workflow Flowcharts

These flowcharts describe the current local MVP workflows. They use Mermaid so GitHub can render them directly from Markdown.

## Homepage Collection

```mermaid
flowchart TD
  start([Start home collector]) --> args[Parse CLI options]
  args --> profile[Open persistent browser profile]
  profile --> auth{Signed in?}
  auth -- no --> creds{--use-credentials?}
  creds -- no --> authFail[Fail with auth guidance]
  creds -- yes --> login[Autofill Facebook login]
  login --> verify{Additional verification?}
  verify -- yes --> authFail
  verify -- no --> market[Open Marketplace homepage or city route]
  auth -- yes --> market
  market --> location{Location option?}
  location -- yes --> route[Use inferred Marketplace route slug]
  location -- no --> scan
  route --> scan[Scan visible listing cards]
  scan --> extract[Extract listing id, title, text, price, rank, href]
  extract --> upsert[Upsert homepage_listings]
  upsert --> bag[Update source metadata and title bag]
  bag --> mode{Run mode}
  mode -- first-load/once --> finish([Exit])
  mode -- continuous --> sleep[Sleep with refresh jitter]
  sleep --> market
```

## Search Exploration

```mermaid
flowchart TD
  start([Start search explorer]) --> args[Parse query, area, location, timing, reseed controls]
  args --> profile[Open persistent browser profile]
  profile --> auth{Signed in?}
  auth -- no --> login[Credential login when enabled]
  auth -- yes --> query
  login --> query[Choose round query]
  query --> seed{Reseed round?}
  seed -- yes --> seedQuery[Use configured seed query]
  seed -- no --> bagQuery[Use title-bag keyword query]
  seedQuery --> openSearch[Open Marketplace search route]
  bagQuery --> openSearch
  openSearch --> location{Location/radius requested?}
  location -- yes --> picker[Attempt UI location/radius controls]
  location -- no --> scroll
  picker --> scroll[Scroll result cards]
  scroll --> extract[Extract cards and source keyword]
  extract --> upsert[Upsert rows into homepage_listings]
  upsert --> titleBag[Feed title bag from useful titles]
  titleBag --> limit{Runtime or once limit reached?}
  limit -- yes --> finish([Exit])
  limit -- no --> wait[Sleep with refresh jitter]
  wait --> query
```

## Backlog Resolution

```mermaid
flowchart TD
  start([Start backlog resolver]) --> args[Parse status, source, keyword, order, time window, selected ids]
  args --> selected{Listing id file or explicit ids?}
  selected -- yes --> temp[Install selected ids temp table]
  selected -- no --> profile
  temp --> profile[Open persistent browser profile]
  profile --> auth{Fully authenticated with c_user?}
  auth -- no --> login{Credential login enabled?}
  login -- no --> authFail[Fail with persistent-profile guidance]
  login -- yes --> verify{Facebook verification required?}
  verify -- yes --> authFail2[Fail with headed verification guidance]
  verify -- no --> claim
  auth -- yes --> claim[Claim next eligible row]
  claim --> empty{Claim found?}
  empty -- no --> mode{Drain mode?}
  mode -- yes --> finish([Exit])
  mode -- no --> pollSleep[Sleep with poll jitter]
  pollSleep --> claim
  empty -- yes --> open[Open listing detail page]
  open --> unavailable{Unavailable/sold/pending signal?}
  unavailable -- sold/pending --> inactive[Record POV event and mark sold/pending_sale]
  unavailable -- unavailable --> fail[Record failure event and retry state]
  unavailable -- available --> capture[Expand detail, capture screenshot, thumbnails, snapshot]
  capture --> content[Build stable detail event content]
  content --> changed{Content hash changed?}
  changed -- yes --> changeEvent[Append content_changed event]
  changed -- no --> done
  changeEvent --> done[Mark listing done and append success event]
  inactive --> next{Limit reached?}
  fail --> next
  done --> next
  next -- yes --> finish
  next -- no --> itemSleep{Item delay configured?}
  itemSleep -- yes --> waitItem[Sleep with item jitter]
  itemSleep -- no --> claim
  waitItem --> claim
```

## Listings Viewer Resolve Dispatch

```mermaid
flowchart TD
  start([User clicks Fetch / Resolve Selected / Resolve All In View]) --> mode{Resolve mode}
  mode -- single row --> ids[Validate selected backlog listing id]
  mode -- selected --> selected[Read selected table rows]
  mode -- query --> query[Build listing ids from current query and sort]
  ids --> filter[Keep pending/error/stale-processing rows]
  selected --> filter
  query --> filter
  filter --> none{Any eligible ids?}
  none -- no --> userError[Return 400 with explainable message]
  none -- yes --> batch[Write resolve batch JSON file]
  batch --> worker[Start managed backlog-resolve/backlog-worker]
  worker --> response[Return process id and listing count]
  response --> watch[Frontend watches /api/workflows]
  watch --> running{Worker finished?}
  running -- no --> status[Show running status]
  status --> watch
  running -- failed --> fail[Show worker failure summary]
  running -- exited --> refresh[Refresh listings table]
```

## Worker Management UI

```mermaid
flowchart TD
  start([Open Workers tab]) --> definitions[Load workflow definitions]
  definitions --> drafts[Initialize per-workflow draft state]
  drafts --> render[Render compact two-column control table]
  render --> edit{User edits fields?}
  edit -- yes --> updateDraft[Update draft and command preview]
  updateDraft --> render
  edit -- no --> poll[Poll /api/workflows]
  poll --> changed{Definitions changed?}
  changed -- yes --> render
  changed -- no --> overview[Refresh worker overview table only]
  overview --> inspect{Open worker detail?}
  inspect -- yes --> detail[Load worker stats and event category table]
  detail --> modal[Show centered inspector with status, preview, events, logs]
  modal --> category{Change event category?}
  category -- yes --> detail
  category -- no --> poll
  inspect -- no --> action{Start/stop/reconcile?}
  action -- start --> startWorker[POST /api/workflows/start]
  action -- stop --> stopWorker[POST /api/workflows/stop]
  action -- reconcile --> reconcile[POST /api/workflows/reconcile]
  startWorker --> poll
  stopWorker --> poll
  reconcile --> poll
```

