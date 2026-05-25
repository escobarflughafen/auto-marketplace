# Remote Troubleshooting Scripts

Run these on the remote host from `/srv/auto-browser/app`.

```bash
scripts/remote-troubleshoot/worker-health.sh
scripts/remote-troubleshoot/recent-workers.sh 10
scripts/remote-troubleshoot/worker-pid.sh 298
scripts/remote-troubleshoot/worker-run.sh backlog-resolve-1779563681628
scripts/remote-troubleshoot/stuck-processing.sh 15 50
scripts/remote-troubleshoot/reset-processing.sh 1430193998420742
scripts/remote-troubleshoot/reset-processing.sh 1430193998420742 --apply
scripts/remote-troubleshoot/reset-processing.sh --older-than-minutes 60
scripts/remote-troubleshoot/reset-processing.sh --older-than-minutes 60 --apply
```

`reset-processing.sh` is dry-run by default. It only changes rows when `--apply` is present.

Set `AUTO_BROWSER_CONTAINER` if the container name is not `auto-browser`, and `AUTO_BROWSER_PORT` if the app is not on `21435`.
