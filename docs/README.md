# Docs

- [Internal Alpha Guide](../ALPHA.md)
- [Marketplace Homepage Pipeline Overview](./marketplace-homepage-pipeline-overview.md)
- [Marketplace Workflow Flowcharts](./marketplace-workflow-flowcharts.md)
- [Marketplace SQLite Maintenance](./marketplace-db-maintenance.md)
- [Trading History CSV](./trading-history-csv.md)
- [Remote Migration](./remote-migration.md)
- [Marketplace Storage Handoff](./marketplace-storage-handoff.md)
- [Marketplace Stability Issues](./marketplace-stability-issues.md)
- [Marketplace Deploy Modes](./marketplace-deploy-modes.md)
- [Internal Alpha Release Goals](./internal-alpha-release-goals.md)
- [Marketplace Resolver Worker Integration Handoff](./marketplace-resolver-worker-integration.md)
- [Marketplace Worker Scheduling and Backlog Plan](./marketplace-worker-scheduling-and-backlog-plan.md)
- [Listing Data Platform Architecture](./listing-data-platform-architecture.md)
- [Remote Worker Installable Runtime Design](./remote-worker-installable-runtime-design.md)
- [Remote Worker Host API v2 Design](./remote-worker-host-api-v2-design.md)
- [Remote Worker General Prototype](./remote-worker-general-prototype.md)

Current implementation status lives in the main [README](../README.md). The homepage overview tracks the local SQLite/Playwright pipeline, Tabulator management UI, listing subtabs, Trade & Match recommendations, profile onboarding, backlog indexer, and audit model. The flowcharts document gives a visual reference for each MVP workflow. The maintenance document covers scheduled SQLite optimization and stale processing recovery. The remote migration document covers Ubuntu service-user setup and runtime data migration. The storage handoff summarizes screenshot artifact savings and follow-up compaction work. The stability document tracks current operational risks and near-term fixes. The deploy modes document covers static hot deploys, app restarts, full rebuilds, and dirty-tree preflight behavior. The alpha goals document turns release gaps into scoped internal-alpha work items. The resolver worker handoff captures how to turn the current on-demand resolver into a first-class managed worker and distinguishes it from the non-browser backlog indexer. The worker scheduling plan records the current backlog model, the interactive profile-onboarder command channel, and the planned migration of recommendation refresh into a dedicated worker. The remote worker installable runtime design covers worker installation, scoped authentication, HTTP/TCP transport, local batch caching, self-paced scheduling, and health reporting. The remote worker host API v2 design specifies the central web app receiving API, auth, session, heartbeat, event-ingest, claim, and ACK contracts. The remote worker general prototype defines the shared communication/state/health runtime and the typed task-injection boundary. The architecture document is a future-state platform design for multi-source durable collection.
