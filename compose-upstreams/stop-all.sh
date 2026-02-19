#!/usr/bin/env bash
# Stop all 20 thermoptic stacks.

set -e
cd "$(dirname "$0")/.."

for p in $(seq 3090 3109); do
  echo "Stopping thermoptic-$p..."
  docker compose -f docker-compose.yml -f compose-upstreams/upstream-$p.yml down
done

echo "All 20 stacks stopped."
