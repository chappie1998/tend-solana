# NVDA feed tracking data

Append-only samples from `.github/workflows/feed-tracking.yml`, one
JSON object per line in `data/samples.jsonl`.

This branch deliberately holds no code. It exists so hundreds of
scheduled sample commits do not land on a working branch.

To analyse: copy `data/samples.jsonl` to
`vsol/.feed-tracking/samples.jsonl` and run
`npm --prefix vsol run feed:report`.
