/**
 * Example iteration state module for thermoptic.
 *
 * Runs after each proxy request. Carries state between calls and optionally
 * interacts with the browser via CDP. Supports:
 *   - Lazy onstart: first request navigates to a product page to establish session
 *   - Periodic refresh: every N requests, refresh cookies via CDP
 *
 * Set ITERATION_STATE_MODULE_PATH to use: ITERATION_STATE_MODULE_PATH=./iteration/example-state.js
 */
import CDP from 'chrome-remote-interface';
import * as logger from '../logger.js';

const REFRESH_INTERVAL = 4;

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
    const is_first_request = state.request_count === 1;
    const needs_refresh = state.request_count % REFRESH_INTERVAL === 0;

    active_logger.info('Iteration state module ran.', {
        request_count: state.request_count,
        is_first: is_first_request,
        needs_refresh: needs_refresh,
        url: request ? request.url : undefined
    });

    if (is_first_request) {
        return {
            updated_state: state,
            wants_cdp: true,
            cdp_callback: run_onstart_setup
        };
    }

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

async function run_onstart_setup(cdp_instance, state, active_logger) {
    const url = pick_random_url(ONSTART_URLS);
    active_logger.info('CDP onstart setup: navigating to product page (tab will stay open for refresh).', { url: url });

    const { Target } = cdp_instance;
    const { targetId } = await Target.createTarget({ url: 'about:blank' });
    const init_params = { ...get_cdp_config(), target: targetId };
    const client = await CDP(init_params);
    const { Page } = client;

    await Page.enable();
    await Page.navigate({ url: url });
    await Page.loadEventFired();
    active_logger.info('CDP onstart setup: page loaded successfully.');
    await client.close();

    state.open_tab_target_id = targetId;
    state.initialized_at = Date.now();
    state.initialized = true;
    return state;
}

async function refresh_cookies_via_browser(cdp_instance, state, active_logger) {
    const target_id = state.open_tab_target_id;
    if (!target_id) {
        active_logger.warn('Refresh requested but no open tab (open_tab_target_id missing); skipping.');
        state.last_refresh_at = Date.now();
        state.refresh_count = (state.refresh_count || 0) + 1;
        return state;
    }

    active_logger.info('CDP refresh: reloading product page.', { target_id: target_id });
    const init_params = { ...get_cdp_config(), target: target_id };
    const client = await CDP(init_params);
    const { Page } = client;

    try {
        await Page.enable();
        await Page.reload();
        await Page.loadEventFired();
        active_logger.info('CDP refresh: page reloaded successfully.');
    } finally {
        await client.close();
    }

    state.last_refresh_at = Date.now();
    state.refresh_count = (state.refresh_count || 0) + 1;
    return state;
}
