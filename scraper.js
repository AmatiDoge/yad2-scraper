const fs = require('fs');
const config = require('./config.json');

// ── Apify actor that handles Yad2's Radware bot protection ──────────────────
// swerve/yad2-scraper uses residential proxies so it works from datacenter IPs.
const APIFY_ACTOR = 'swerve~yad2-scraper';
const APIFY_BASE = 'https://api.apify.com/v2';
const POLL_INTERVAL_MS = 5000;
const POLL_TIMEOUT_MS = 3 * 60 * 1000; // 3 minutes max

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

const apifyRun = async (apifyToken, input) => {
    const url = `${APIFY_BASE}/acts/${APIFY_ACTOR}/runs?token=${apifyToken}`;
    const res = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(input),
    });
    const data = await res.json();
    if (!res.ok || !data.data?.id) {
        throw new Error(`Apify run start failed: ${JSON.stringify(data)}`);
    }
    return data.data.id;
};

const apifyPollUntilDone = async (apifyToken, runId) => {
    const deadline = Date.now() + POLL_TIMEOUT_MS;
    while (Date.now() < deadline) {
        await sleep(POLL_INTERVAL_MS);
        const res = await fetch(`${APIFY_BASE}/acts/${APIFY_ACTOR}/runs/${runId}?token=${apifyToken}`);
        const data = await res.json();
        const status = data.data?.status;
        console.log(`Apify run ${runId}: ${status}`);
        if (status === 'SUCCEEDED') return data.data.defaultDatasetId;
        if (status === 'FAILED' || status === 'ABORTED' || status === 'TIMED-OUT') {
            throw new Error(`Apify run ${runId} ended with status: ${status}`);
        }
    }
    throw new Error(`Apify run ${runId} did not finish within ${POLL_TIMEOUT_MS / 1000}s`);
};

const apifyGetItems = async (apifyToken, datasetId) => {
    const res = await fetch(`${APIFY_BASE}/datasets/${datasetId}/items?token=${apifyToken}&limit=200`);
    if (!res.ok) throw new Error(`Failed to fetch dataset items: ${res.status}`);
    return res.json();
};

const checkIfHasNewItems = (items, topic) => {
    const filePath = `./data/${topic}.json`;
    let seenIds = [];
    try {
        seenIds = require(filePath);
    } catch (e) {
        if (e.code === 'MODULE_NOT_FOUND') {
            if (!fs.existsSync('./data')) fs.mkdirSync('data');
            fs.writeFileSync(filePath, '[]');
        } else {
            throw new Error(`Could not read/create ${filePath}: ${e}`);
        }
    }

    // Filter out IDs no longer in current result set (to keep the list lean)
    const currentIds = new Set(items.map(i => i.listingId).filter(Boolean));
    const updatedSeenIds = seenIds.filter(id => currentIds.has(id));

    const newItems = [];
    for (const item of items) {
        const id = item.listingId;
        if (id && !updatedSeenIds.includes(id)) {
            updatedSeenIds.push(id);
            newItems.push(item);
        }
    }

    if (newItems.length > 0 || updatedSeenIds.length !== seenIds.length) {
        fs.writeFileSync(filePath, JSON.stringify(updatedSeenIds, null, 2));
        fs.writeFileSync('push_me', '');
    }

    return newItems;
};

const forwardToIngest = async (newItems) => {
    const ingestUrl = process.env.INGEST_URL;
    const ingestSecret = process.env.INGEST_SECRET;
    if (!ingestUrl) {
        console.log('INGEST_URL not set, skipping forward to Dira Finder ingest');
        return;
    }
    const posts = newItems.map(item => {
        const parts = [
            item.address,
            item.neighbourhood,
            item.price ? `₪${item.price}` : null,
            item.rooms ? `${item.rooms} חד׳` : null,
            item.areaSqm ? `${item.areaSqm}מ"ר` : null,
            item.listingDescription,
            item.contactPhone,
        ].filter(Boolean);
        return {
            source: 'yad2',
            group_name: null,
            post_url: item.url,
            author: item.contactName || null,
            raw_text: parts.join(' | '),
        };
    });
    if (posts.length === 0) return;
    try {
        const res = await fetch(ingestUrl, {
            method: 'POST',
            headers: {
                'content-type': 'application/json',
                'x-ingest-secret': ingestSecret || '',
            },
            body: JSON.stringify({ posts }),
        });
        const body = await res.text();
        console.log(`Ingest response: ${res.status} ${body}`);
    } catch (err) {
        console.log('Error forwarding to ingest:', err);
    }
};

const sendTelegram = async (apiToken, chatId, message) => {
    if (!apiToken || !chatId) return;
    try {
        await fetch(`https://api.telegram.org/bot${apiToken}/sendMessage`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ chat_id: chatId, text: message }),
        });
    } catch (err) {
        console.log('Telegram send error:', err);
    }
};

const scrape = async (project) => {
    const { topic, apifyInput } = project;
    const apifyToken = process.env.APIFY_TOKEN || config.apifyToken;
    const apiToken = process.env.API_TOKEN || config.telegramApiToken;
    const chatId = process.env.CHAT_ID || config.chatId;
    const telegramEnabled = !!(apiToken && chatId);

    if (!apifyToken) throw new Error('APIFY_TOKEN is required');

    console.log(`Starting Apify run for topic "${topic}" with input: ${JSON.stringify(apifyInput)}`);
    if (telegramEnabled) {
        await sendTelegram(apiToken, chatId, `Starting Yad2 scan: ${topic}`);
    }

    try {
        const runId = await apifyRun(apifyToken, apifyInput);
        const datasetId = await apifyPollUntilDone(apifyToken, runId);
        const items = await apifyGetItems(apifyToken, datasetId);
        console.log(`Got ${items.length} items from Apify for topic "${topic}"`);

        const newItems = checkIfHasNewItems(items, topic);
        console.log(`${newItems.length} new items for topic "${topic}"`);

        if (newItems.length > 0) {
            await forwardToIngest(newItems);
            if (telegramEnabled) {
                const msg = `${newItems.length} new Yad2 listings:\n` +
                    newItems.slice(0, 5).map(i => i.url).join('\n');
                await sendTelegram(apiToken, chatId, msg);
            }
        } else {
            console.log('No new listings');
            if (telegramEnabled) {
                await sendTelegram(apiToken, chatId, `No new Yad2 listings for ${topic}`);
            }
        }
    } catch (e) {
        const msg = `Scan failed for ${topic}: ${e?.message || e}`;
        console.log(msg);
        if (telegramEnabled) await sendTelegram(apiToken, chatId, msg);
        throw e;
    }
};

const program = async () => {
    const activeProjects = config.projects.filter(p => {
        if (p.disabled) console.log(`Topic "${p.topic}" is disabled. Skipping.`);
        return !p.disabled;
    });
    await Promise.all(activeProjects.map(p => scrape(p)));
};

program();
