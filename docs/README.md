# Docs

- [Internal Alpha Guide](../ALPHA.md)
- [Marketplace Homepage Pipeline Overview](./marketplace-homepage-pipeline-overview.md)
- [Marketplace Workflow Flowcharts](./marketplace-workflow-flowcharts.md)
- [Marketplace SQLite Maintenance](./marketplace-db-maintenance.md)
- [Trading History CSV](./trading-history-csv.md)
- [Remote Migration](./remote-migration.md)
- [Marketplace Storage Handoff](./marketplace-storage-handoff.md)
- [Marketplace Stability Issues](./marketplace-stability-issues.md)
- [Internal Alpha Release Goals](./internal-alpha-release-goals.md)
- [Marketplace Resolver Worker Integration Handoff](./marketplace-resolver-worker-integration.md)
- [Marketplace Worker Scheduling and Backlog Plan](./marketplace-worker-scheduling-and-backlog-plan.md)
- [Listing Data Platform Architecture](./listing-data-platform-architecture.md)

Current implementation status lives in the main [README](../README.md). The homepage overview tracks the local SQLite/Playwright pipeline, Tabulator management UI, backlog resolver controls, and audit model. The flowcharts document gives a visual reference for each MVP workflow. The maintenance document covers scheduled SQLite optimization. The remote migration document covers Ubuntu service-user setup and runtime data migration. The storage handoff summarizes screenshot artifact savings and follow-up compaction work. The stability document tracks current operational risks and near-term fixes. The alpha goals document turns release gaps into scoped internal-alpha work items. The resolver worker handoff captures how to turn the current on-demand resolver into a first-class managed worker and distinguishes it from the non-browser backlog indexer. The worker scheduling plan records the current backlog model and the planned migration of recommendation refresh into a dedicated worker. The architecture document is a future-state platform design for multi-source durable collection.
