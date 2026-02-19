# Upstream proxy compose overrides

Each file routes thermoptic traffic through a different upstream proxy on the host
(localhost:PORT). Use with the base compose:

```bash
# Single stack (e.g. upstream proxy on localhost:3090)
docker compose -f docker-compose.yml -f compose-upstreams/upstream-3090.yml up -d

# All 20 stacks (ports 3090–3109)
./compose-upstreams/start-all.sh
# Stop all:
./compose-upstreams/stop-all.sh
```

Each stack exposes:
- Thermoptic proxy: `127.0.0.1:PORT` (client connects here; Chrome routes through host proxy on same port)
- Xpra UI: `127.0.0.1:14111` … `127.0.0.1:14130` (one per stack)

| Port | Thermoptic | Xpra |
|------|------------|------|
| 3090 | 127.0.0.1:3090 | 127.0.0.1:14111 |
| 3091 | 127.0.0.1:3091 | 127.0.0.1:14112 |
| … | … | … |
| 3109 | 127.0.0.1:3109 | 127.0.0.1:14130 |
