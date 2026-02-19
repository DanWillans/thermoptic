# Upstream proxy compose overrides

Each file routes thermoptic traffic through a different upstream proxy on the host
(localhost:PORT). Use with the base compose:

```bash
# Single stack (e.g. upstream proxy on localhost:3090)
docker compose -f docker-compose.yml -f compose-upstreams/clear-ports.yml -f compose-upstreams/upstream-3090.yml up -d

# All 20 stacks (ports 3090–3109)
./compose-upstreams/start-all.sh
# Stop all:
./compose-upstreams/stop-all.sh
```

Flow: Client → thermoptic → Chrome → proxyrouter → host:UPSTREAM_PORT → internet

Each stack exposes:
- Thermoptic proxy: `127.0.0.1:13090` … `127.0.0.1:13109` (client connects here)
- GUI/Xpra: disabled (headless Chrome only)

Upstream proxies (your proxies) must run on host ports 3090–3109.

| Upstream | Thermoptic (client) |
|----------|---------------------|
| host:3090 | 127.0.0.1:13090 |
| host:3091 | 127.0.0.1:13091 |
| … | … |
| host:3109 | 127.0.0.1:13109 |
