import { createServer } from 'node:http';
import { request as http_request } from 'node:http';
import * as cdp from './cdp.js';
import * as config from './config.js';
import * as utils from './utils.js';
import * as logger from './logger.js';

const control_logger = logger.get_logger();

function parse_json_body(req) {
    return new Promise((resolve, reject) => {
        const chunks = [];
        req.on('data', chunk => chunks.push(chunk));
        req.on('end', () => {
            const raw = Buffer.concat(chunks).toString('utf8');
            if (!raw.trim()) {
                resolve({});
                return;
            }
            try {
                resolve(JSON.parse(raw));
            } catch (err) {
                reject(new Error('Invalid JSON body'));
            }
        });
        req.on('error', reject);
    });
}

function json_response(res, status_code, data) {
    const body = JSON.stringify(data);
    res.writeHead(status_code, {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body)
    });
    res.end(body);
}

function check_api_key(req) {
    if (!config.CONTROL_PLANE_API_KEY) {
        return true;
    }
    const provided = req.headers['x-api-key'];
    if (!provided) {
        return false;
    }
    return utils.time_safe_compare(config.CONTROL_PLANE_API_KEY, provided);
}

function proxy_to_chrome_control(method, path, timeout_ms = 5000) {
    const host = process.env.CHROME_RESTART_HOST || process.env.CHROME_DEBUGGING_HOST || 'chrome';
    const port = parseInt(process.env.CHROME_CONTROL_PORT || '9223', 10);

    return new Promise((resolve, reject) => {
        const req = http_request({
            host,
            port,
            path,
            method,
            timeout: timeout_ms,
            headers: { 'Content-Length': '0' }
        }, (res) => {
            const chunks = [];
            res.on('data', chunk => chunks.push(chunk));
            res.on('end', () => {
                const body = Buffer.concat(chunks).toString('utf8');
                let parsed;
                try {
                    parsed = JSON.parse(body);
                } catch {
                    parsed = { raw: body };
                }
                resolve({ status_code: res.statusCode, data: parsed });
            });
        });
        req.on('timeout', () => req.destroy(new Error('Request timed out')));
        req.on('error', reject);
        req.end();
    });
}

function create_router(stats) {
    const routes = [];

    function add(method, path, handler) {
        routes.push({ method, path, handler });
    }

    // Cookie Management
    add('GET', '/api/v1/cookies', async (req, res, query) => {
        const domain = query.get('domain') || null;
        const cookies = await cdp.get_all_cookies(domain);
        json_response(res, 200, { cookies, count: cookies.length });
    });

    add('POST', '/api/v1/cookies', async (req, res) => {
        const body = await parse_json_body(req);
        const cookies = body.cookies;
        if (!Array.isArray(cookies) || cookies.length === 0) {
            json_response(res, 400, { error: 'Body must contain a "cookies" array with at least one cookie object' });
            return;
        }
        await cdp.set_browser_cookies(cookies);
        json_response(res, 200, { set: true, count: cookies.length });
    });

    add('DELETE', '/api/v1/cookies', async (req, res, query) => {
        const domain = query.get('domain') || null;
        const result = await cdp.clear_cookies_for_domain(domain);
        json_response(res, 200, result);
    });

    // Browser Control
    add('POST', '/api/v1/chrome/restart', async (req, res) => {
        const result = await proxy_to_chrome_control('POST', '/restart');
        json_response(res, result.status_code >= 200 && result.status_code < 300 ? 200 : 502, result.data);
    });

    add('GET', '/api/v1/chrome/status', async (req, res) => {
        const result = await proxy_to_chrome_control('GET', '/status');
        json_response(res, result.status_code >= 200 && result.status_code < 300 ? 200 : 502, result.data);
    });

    add('POST', '/api/v1/cache/clear', async (req, res) => {
        const result = await cdp.clear_browser_cache();
        json_response(res, 200, result);
    });

    // Tab Management
    add('GET', '/api/v1/tabs', async (req, res) => {
        const [targets, tracked_tabs] = await Promise.all([
            cdp.list_targets(),
            Promise.resolve(cdp.get_open_tabs_snapshot())
        ]);
        json_response(res, 200, {
            targets,
            tracked_tabs,
            target_count: targets.length,
            tracked_count: tracked_tabs.length
        });
    });

    add('DELETE', '/api/v1/tabs/:targetId', async (req, res, query, params) => {
        const target_id = params.targetId;
        if (!target_id) {
            json_response(res, 400, { error: 'Missing targetId parameter' });
            return;
        }
        const result = await cdp.close_target(target_id);
        json_response(res, 200, result);
    });

    // Status and Stats
    add('GET', '/api/v1/status', async (req, res) => {
        json_response(res, 200, {
            uptime_ms: Date.now() - stats.started_at,
            started_at: new Date(stats.started_at).toISOString(),
            total_requests: stats.total_requests,
            successful_requests: stats.successful_requests,
            failed_requests: stats.failed_requests,
            recent_error_count: stats.recent_errors.length,
            last_health_check: stats.last_health_check
        });
    });

    add('GET', '/api/v1/stats', async (req, res) => {
        json_response(res, 200, {
            started_at: new Date(stats.started_at).toISOString(),
            uptime_ms: Date.now() - stats.started_at,
            total_requests: stats.total_requests,
            successful_requests: stats.successful_requests,
            failed_requests: stats.failed_requests,
            status_codes: stats.status_codes,
            recent_errors: stats.recent_errors
        });
    });

    add('GET', '/api/v1/blocks', async (req, res) => {
        json_response(res, 200, {
            recent_blocks: stats.recent_blocks,
            count: stats.recent_blocks.length
        });
    });

    // Chrome Interactive Session
    add('POST', '/api/v1/chrome/navigate', async (req, res) => {
        const body = await parse_json_body(req);
        const url = body.url;
        if (!url || typeof url !== 'string') {
            json_response(res, 400, { error: 'Missing or invalid "url" in request body' });
            return;
        }
        const wait = body.wait !== false;
        const result = await cdp.control_navigate(url, wait);
        json_response(res, 200, result);
    });

    add('POST', '/api/v1/chrome/evaluate', async (req, res) => {
        const body = await parse_json_body(req);
        const expression = body.expression;
        if (!expression || typeof expression !== 'string') {
            json_response(res, 400, { error: 'Missing or invalid "expression" in request body' });
            return;
        }
        const result = await cdp.control_evaluate(expression);
        json_response(res, 200, result);
    });

    add('GET', '/api/v1/chrome/screenshot', async (req, res, query) => {
        const format = query.get('format') || 'png';
        const quality = query.get('quality') ? parseInt(query.get('quality'), 10) : undefined;
        const data = await cdp.control_screenshot(format, quality);

        if (query.get('raw') === 'true') {
            const mime = format === 'jpeg' ? 'image/jpeg' : 'image/png';
            const buf = Buffer.from(data, 'base64');
            res.writeHead(200, {
                'Content-Type': mime,
                'Content-Length': buf.length
            });
            res.end(buf);
            return;
        }

        json_response(res, 200, { format, data });
    });

    add('GET', '/api/v1/chrome/page', async (req, res) => {
        const info = await cdp.control_get_page_info();
        json_response(res, 200, info);
    });

    add('DELETE', '/api/v1/chrome/session', async (req, res) => {
        const result = await cdp.close_control_session();
        json_response(res, 200, result);
    });

    // Hook Execution
    add('POST', '/api/v1/hooks/run', async (req, res) => {
        const body = await parse_json_body(req);
        const hook_file = body.hook_file;
        if (!hook_file || typeof hook_file !== 'string') {
            json_response(res, 400, { error: 'Missing or invalid hook_file in request body' });
            return;
        }
        const hook_logger = logger.get_request_logger({ request_id: `hook-${Date.now()}` });
        let cdp_instance = null;
        try {
            cdp_instance = await cdp.start_browser_session();
            await utils.run_hook_file(hook_file, cdp_instance, null, null, hook_logger);
            json_response(res, 200, { executed: true, hook_file });
        } finally {
            if (cdp_instance) {
                try { await cdp_instance.close(); } catch {}
            }
        }
    });

    function match(method, pathname) {
        for (const route of routes) {
            if (route.method !== method) continue;

            // Check for parameterized routes
            if (route.path.includes(':')) {
                const route_parts = route.path.split('/');
                const path_parts = pathname.split('/');
                if (route_parts.length !== path_parts.length) continue;

                const params = {};
                let matched = true;
                for (let i = 0; i < route_parts.length; i++) {
                    if (route_parts[i].startsWith(':')) {
                        params[route_parts[i].slice(1)] = decodeURIComponent(path_parts[i]);
                    } else if (route_parts[i] !== path_parts[i]) {
                        matched = false;
                        break;
                    }
                }
                if (matched) return { handler: route.handler, params };
            } else if (route.path === pathname) {
                return { handler: route.handler, params: {} };
            }
        }
        return null;
    }

    return { match };
}

export function start_control_plane(stats) {
    if (!config.CONTROL_PLANE_ENABLED) {
        control_logger.info('Control plane disabled by configuration.');
        return Promise.resolve(null);
    }

    const router = create_router(stats);

    return new Promise((resolve, reject) => {
        const server = createServer(async (req, res) => {
            if (!check_api_key(req)) {
                json_response(res, 401, { error: 'Unauthorized: invalid or missing X-API-Key header' });
                return;
            }

            const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
            const method = req.method.toUpperCase();
            const pathname = url.pathname;
            const query = url.searchParams;

            const route_match = router.match(method, pathname);
            if (!route_match) {
                json_response(res, 404, { error: 'Not found', path: pathname, method });
                return;
            }

            try {
                await route_match.handler(req, res, query, route_match.params);
            } catch (err) {
                const message = err instanceof Error ? err.message : String(err);
                control_logger.error('Control plane request failed.', {
                    method,
                    path: pathname,
                    error: message
                });
                json_response(res, 500, { error: message });
            }
        });

        server.on('error', (err) => {
            reject(err);
        });

        server.listen(config.CONTROL_PLANE_PORT, '0.0.0.0', () => {
            control_logger.info('Control plane listening.', {
                port: config.CONTROL_PLANE_PORT
            });
            resolve(server);
        });
    });
}
