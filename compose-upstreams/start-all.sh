#!/usr/bin/env bash
# Start all 20 thermoptic stacks (ports 3090-3109).
# Ensure upstream proxies are listening on localhost:3090 through localhost:3109 before running.

set -e
cd "$(dirname "$0")/.."

for p in $(seq 3090 3109); do
  echo "Starting thermoptic-$p..."
  docker compose -f compose-upstreams/base.yml -f compose-upstreams/upstream-$p.yml up -d
done

echo "All 20 stacks started. Thermoptic proxies: 127.0.0.1:13090-13109 (routing through host:3090-3109)"
