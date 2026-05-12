# Marketplace SQLite Maintenance

The local Marketplace monitor is expected to stay SQLite-backed for the current growth rate. At roughly 1,000 new listings per day, regular lightweight maintenance is enough.

## Command

Dry-run report:

```bash
npm run marketplace:home:db:maintain -- --dry-run
```

Default maintenance:

```bash
npm run marketplace:home:db:maintain
```

The default command runs:

- `PRAGMA optimize`
- `PRAGMA wal_checkpoint(TRUNCATE)`

Optional deeper maintenance:

```bash
npm run marketplace:home:db:maintain -- --analyze
npm run marketplace:home:db:maintain -- --vacuum
```

Use `--vacuum` manually during a quiet period. It rewrites the DB file and is not needed for routine daily operation unless the DB has had large deletes or schema churn.

## Suggested Schedule

For the current MVP workload:

- every 6 hours: default maintenance
- weekly or after large imports: `--analyze`
- manual only: `--vacuum`

Ready-to-edit scheduler templates are available in:

- `ops/marketplace-db-maintenance.cron.example`
- `ops/com.auto-browser.marketplace-db-maintenance.plist.example`
- `ops/marketplace-db-maintenance.service.example`
- `ops/marketplace-db-maintenance.timer.example`
- `ops/marketplace-db-analyze.service.example`
- `ops/marketplace-db-analyze.timer.example`

## Cron

Example cron entry for the default maintenance every 6 hours:

```cron
0 */6 * * * cd /srv/auto-browser/app && /usr/bin/env npm run marketplace:home:db:maintain -- --json >> artifacts/marketplace-homepage/db-maintenance.log 2>&1
```

Weekly statistics refresh:

```cron
30 3 * * 0 cd /srv/auto-browser/app && /usr/bin/env npm run marketplace:home:db:maintain -- --analyze --json >> artifacts/marketplace-homepage/db-maintenance.log 2>&1
```

## macOS LaunchAgent

Create `~/Library/LaunchAgents/com.auto-browser.marketplace-db-maintenance.plist`:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.auto-browser.marketplace-db-maintenance</string>
  <key>WorkingDirectory</key>
  <string>/path/to/auto-browser</string>
  <key>ProgramArguments</key>
  <array>
    <string>/usr/bin/env</string>
    <string>npm</string>
    <string>run</string>
    <string>marketplace:home:db:maintain</string>
    <string>--</string>
    <string>--json</string>
  </array>
  <key>StartInterval</key>
  <integer>21600</integer>
  <key>StandardOutPath</key>
  <string>/path/to/auto-browser/artifacts/marketplace-homepage/db-maintenance.log</string>
  <key>StandardErrorPath</key>
  <string>/path/to/auto-browser/artifacts/marketplace-homepage/db-maintenance.err.log</string>
</dict>
</plist>
```

Load it:

```bash
launchctl load ~/Library/LaunchAgents/com.auto-browser.marketplace-db-maintenance.plist
```

Unload it:

```bash
launchctl unload ~/Library/LaunchAgents/com.auto-browser.marketplace-db-maintenance.plist
```

## Ubuntu systemd

For an Ubuntu server deployment, use the systemd templates in `ops/`. Adjust
`User`, `Group`, and `WorkingDirectory` if the service runs under a different
account or path.

Install the maintenance timer:

```bash
sudo cp ops/marketplace-db-maintenance.service.example /etc/systemd/system/marketplace-db-maintenance.service
sudo cp ops/marketplace-db-maintenance.timer.example /etc/systemd/system/marketplace-db-maintenance.timer
sudo systemctl daemon-reload
sudo systemctl enable --now marketplace-db-maintenance.timer
```

Install the weekly statistics refresh:

```bash
sudo cp ops/marketplace-db-analyze.service.example /etc/systemd/system/marketplace-db-analyze.service
sudo cp ops/marketplace-db-analyze.timer.example /etc/systemd/system/marketplace-db-analyze.timer
sudo systemctl daemon-reload
sudo systemctl enable --now marketplace-db-analyze.timer
```

Check status and recent logs:

```bash
systemctl list-timers 'marketplace-db-*'
systemctl status marketplace-db-maintenance.timer
journalctl -u marketplace-db-maintenance.service -n 100 --no-pager
```

Run manually:

```bash
sudo systemctl start marketplace-db-maintenance.service
sudo systemctl start marketplace-db-analyze.service
```

## Notes

- The maintenance command opens the same SQLite DB path as the monitor by default.
- It does not start collectors or resolver workers.
- It reports DB, WAL, SHM, row counts, page counts, and freelist count before and after maintenance.
- If the monitor is running, WAL checkpointing is still safe; SQLite coordinates readers and writers.
