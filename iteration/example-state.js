/**
 * Example iteration state module for thermoptic.
 *
 * Runs after each proxy request. Carries state between calls and optionally
 * interacts with the browser via CDP. Supports:
 *   - onstart: runs at thermoptic startup (when Chrome is ready) and after Chrome restarts
 *     (when refresh detects a lost tab). Follows the original hooks/onstart pattern but
 *     keeps the tab open for refresh and carries state.
 *   - Periodic refresh: every N requests, refresh cookies via CDP
 *   - Restart recovery: if refresh detects a lost tab, re-runs onstart
 *
 * Set ITERATION_STATE_MODULE_PATH to use: ITERATION_STATE_MODULE_PATH=./iteration/example-state.js
 */
import CDP from 'chrome-remote-interface';
import * as logger from '../logger.js';

const REFRESH_INTERVAL = 4;

const BLOCKED_RESOURCE_TYPES = new Set(['Image', 'Media', 'Font']);

const BLOCKED_DOMAINS = [
    'googletagmanager.com',
    'google-analytics.com',
    'doubleclick.net',
    'facebook.net',
    'hotjar.com',
    'segment.io',
    'optimizely.com',
    'display.ugc.bazaarvoice.com',
    'edge.curalate.com',
    'www.very.co.uk/api/domain-recommendations/recommendations',
    'www.very.co.uk/api/fs-product/marketing-offers/v1/offers',
];

const ONSTART_URLS = [
    'https://www.very.co.uk/levis-565-loose-straight-fit-jeans-right-mind-blue/1601168820.prd',
    'https://www.very.co.uk/mango-winny-sweatshirt-navy/1601251336.prd',
    'http://very.co.uk/adidas-originals-sst-adicolor-loose-sst-denim-black-wash-jacket/2000017782.prd',
    'https://www.very.co.uk/hugo-blue-jinko-small-logo-baseball-cap-one-colour/1601210909.prd',
    'https://www.very.co.uk/apple-airpods-4/1601049005.prd',
    'https://www.very.co.uk/apple-airpodsnbsppronbsp3/1601214439.prd',
    'https://www.very.co.uk/apple-airpods-4-with-active-noise-cancellation/1601049006.prd',
    'https://www.very.co.uk/apple-airpods-max-blue/1601049001.prd',
    'https://www.very.co.uk/apple-airpods-max-starlight/1601049007.prd',
    'https://www.very.co.uk/apple-airpods-max-midnight/1601049021.prd',
    'https://www.very.co.uk/apple-airpods-max-purple/1601049015.prd',
    'https://www.very.co.uk/apple-airpods-max-orange/1601049024.prd',
    'https://www.very.co.uk/apple-earpods-35mm-headphone-plug/1601052539.prd',
    'https://www.very.co.uk/apple-earpods-lightning-connector/1601052540.prd'
];

function pick_random_url(urls) {
    const index = Math.floor(Math.random() * urls.length);
    return urls[index];
}

function should_block_request(resource_type, url) {
    const type = resource_type || '';
    if (BLOCKED_RESOURCE_TYPES.has(type)) {
        return true;
    }
    for (let i = 0; i < BLOCKED_DOMAINS.length; i += 1) {
        if (url.indexOf(BLOCKED_DOMAINS[i]) !== -1) {
            return true;
        }
    }
    return false;
}

async function enable_bandwidth_saving_fetch(client, active_logger) {
    const { Fetch } = client;
    await Fetch.enable({
        patterns: [{ urlPattern: '*' }]
    });
    client.on('Fetch.requestPaused', async (params) => {
        const request_id = params.requestId;
        const resource_type = params.resourceType;
        const url = (params.request && params.request.url) || '';
        const is_request_stage = params.responseStatusCode === undefined;
        if (!is_request_stage) {
            await Fetch.continueRequest({ requestId: request_id });
            return;
        }
        try {
            if (should_block_request(resource_type, url)) {
                await Fetch.failRequest({
                    requestId: request_id,
                    errorReason: 'BlockedByClient'
                });
                active_logger.debug('CDP fetch blocked.', { url: url, resource_type: resource_type });
            } else {
                await Fetch.continueRequest({ requestId: request_id });
            }
        } catch (err) {
            active_logger.warn('CDP Fetch handler error.', {
                message: err && err.message ? err.message : String(err)
            });
            try {
                await Fetch.continueRequest({ requestId: request_id });
            } catch (continue_err) {
                active_logger.warn('CDP Fetch continueRequest failed after handler error.', {
                    message: continue_err && continue_err.message ? continue_err.message : String(continue_err)
                });
            }
        }
    });
}

function get_cdp_config() {
    let port = 9222;
    let host = '127.0.0.1';
    if (process.env.CHROME_DEBUGGING_HOST) {
        host = process.env.CHROME_DEBUGGING_HOST;
    }
    if (process.env.CHROME_DEBUGGING_PORT) {
        port = parseInt(process.env.CHROME_DEBUGGING_PORT);
    }
    return { host, port };
}

export async function after_iteration(context) {
    const state = context.state;
    const request = context.request;
    const response = context.response;
    const active_logger = context.logger || logger.get_logger();

    state.request_count = (state.request_count || 0) + 1;
    const needs_refresh = state.request_count % REFRESH_INTERVAL === 0;

    active_logger.info('Iteration state module ran.', {
        request_count: state.request_count,
        needs_refresh: needs_refresh,
        url: request ? request.url : undefined
    });

    if (needs_refresh) {
        return {
            updated_state: state,
            wants_cdp: true,
            cdp_callback: refresh_cookies_via_browser
        };
    }

    return {
        updated_state: state,
        wants_cdp: false
    };
}

export async function run_onstart_setup(cdp_instance, state, active_logger) {
    const url = pick_random_url(ONSTART_URLS);
    active_logger.info('CDP onstart setup: navigating to product page (tab will stay open for refresh).', { url: url });

    const { Target } = cdp_instance;
    const { targetId } = await Target.createTarget({ url: 'about:blank' });
    const init_params = { ...get_cdp_config(), target: targetId };
    const client = await CDP(init_params);
    const { Page } = client;

    await Page.enable();
    await enable_bandwidth_saving_fetch(client, active_logger);
    await Page.navigate({ url: url });
    await Page.loadEventFired();
    active_logger.info('CDP onstart setup: page loaded successfully.');
    await client.close();

    state.open_tab_target_id = targetId;
    state.initialized_at = Date.now();
    state.initialized = true;
    return state;
}

function is_target_gone_error(err) {
    const msg = err && err.message ? String(err.message).toLowerCase() : '';
    return (
        msg.includes('target') && (msg.includes('closed') || msg.includes('not found') || msg.includes('detached')) ||
        msg.includes('session') && msg.includes('closed') ||
        msg.includes('inspected target navigated or closed')
    );
}

async function refresh_cookies_via_browser(cdp_instance, state, active_logger) {
    const target_id = state.open_tab_target_id;
    if (!target_id) {
        active_logger.info('Refresh requested but no open tab (likely browser restarted); running onstart instead.');
        return run_onstart_setup(cdp_instance, state, active_logger);
    }

    active_logger.info('CDP refresh: reloading product page.', { target_id: target_id });
    const init_params = { ...get_cdp_config(), target: target_id };
    let client;
    try {
        client = await CDP(init_params);
    } catch (connect_err) {
        if (is_target_gone_error(connect_err)) {
            active_logger.info('CDP refresh: target no longer exists (likely browser restarted); running onstart instead.', {
                message: connect_err.message
            });
            return run_onstart_setup(cdp_instance, state, active_logger);
        }
        throw connect_err;
    }

    const { Page } = client;
    try {
        await Page.enable();
        await enable_bandwidth_saving_fetch(client, active_logger);
        await Page.reload();
        await Page.loadEventFired();
        active_logger.info('CDP refresh: page reloaded successfully.');
    } catch (op_err) {
        if (is_target_gone_error(op_err)) {
            active_logger.info('CDP refresh: target lost during refresh (likely browser restarted); running onstart instead.', {
                message: op_err.message
            });
            try {
                await client.close();
            } catch (e) {
                /* ignored */
            }
            return run_onstart_setup(cdp_instance, state, active_logger);
        }
        throw op_err;
    } finally {
        try {
            if (client) {
                await client.close();
            }
        } catch (e) {
            /* ignored */
        }
    }

    state.last_refresh_at = Date.now();
    state.refresh_count = (state.refresh_count || 0) + 1;
    return state;
}
