const cheerio = require('cheerio');
const fs = require('fs');
const config = require('./config.json');

const getYad2Response = async (url) => {
    const requestOptions = {
        method: 'GET',
        redirect: 'follow',
        headers: {
            'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
            'Accept-Language': 'he-IL,he;q=0.9,en-US;q=0.8',
        }
    };
    try {
        const res = await fetch(url, requestOptions)
        return await res.text()
    } catch (err) {
        console.log(err)
    }
}

const scrapeItemsAndExtractData = async (url) => {
    const yad2Html = await getYad2Response(url);
    if (!yad2Html) {
        throw new Error("Could not get Yad2 response");
    }
    const $ = cheerio.load(yad2Html);
    const title = $("title")
    const titleText = title.first().text();
    if (titleText === "ShieldSquare Captcha" || titleText.includes("Radware")) {
        throw new Error("Bot detection");
    }
    const $feedItems = $(".feeditem");
    if (!$feedItems || $feedItems.length === 0) {
        console.log("Warning: Could not find feed items (0 results or page structure changed)");
        return [];
    }
    const items = [];
    $feedItems.each((_, elm) => {
        const $item = $(elm);
        const imgSrc = $item.find(".pic img").attr('src') || null;
        const linkHref = $item.find("a").attr('href') || null;
        const postUrl = linkHref
            ? (linkHref.startsWith('http') ? linkHref : `https://www.yad2.co.il${linkHref}`)
            : null;
        const itemTitle = $item.find(".title").text().trim() || null;
        const itemPrice = $item.find(".price").text().trim() || null;
        const itemDesc = $item.find(".subtitle, .row-subtitle, .info-row").text().trim() || null;
        // Use imgSrc as the dedup key (original behavior), postUrl for ingest
        if (imgSrc || postUrl) {
            items.push({ imgSrc, postUrl, title: itemTitle, price: itemPrice, description: itemDesc });
        }
    });
    return items;
}

const checkIfHasNewItems = async (items, topic) => {
    const filePath = `./data/${topic}.json`;
    let savedKeys = [];
    try {
        savedKeys = require(filePath);
    } catch (e) {
        if (e.code === "MODULE_NOT_FOUND") {
            if (!fs.existsSync('./data')) {
                fs.mkdirSync('data');
            }
            fs.writeFileSync(filePath, '[]');
        } else {
            console.log(e);
            throw new Error(`Could not read / create ${filePath}`);
        }
    }
    // Use imgSrc (or postUrl as fallback) as the dedup key
    const getKey = (item) => item.imgSrc || item.postUrl;
    let shouldUpdateFile = false;
    savedKeys = savedKeys.filter(savedKey => {
        const stillPresent = items.some(item => getKey(item) === savedKey);
        if (!stillPresent) shouldUpdateFile = true;
        return stillPresent;
    });
    const newItems = [];
    items.forEach(item => {
        const key = getKey(item);
        if (key && !savedKeys.includes(key)) {
            savedKeys.push(key);
            newItems.push(item);
            shouldUpdateFile = true;
        }
    });
    if (shouldUpdateFile) {
        fs.writeFileSync(filePath, JSON.stringify(savedKeys, null, 2));
        createPushFlagForWorkflow();
    }
    return newItems;
}

const createPushFlagForWorkflow = () => {
    fs.writeFileSync("push_me", "")
}

const forwardToIngest = async (newItems, topicUrl) => {
    const ingestUrl = process.env.INGEST_URL;
    const ingestSecret = process.env.INGEST_SECRET;
    if (!ingestUrl) {
        console.log("INGEST_URL not set, skipping forward to ingest");
        return;
    }
    const posts = newItems.map(item => ({
        source: "yad2",
        group_name: null,
        post_url: item.postUrl || topicUrl,
        author: null,
        raw_text: [item.title, item.price, item.description].filter(Boolean).join(" | "),
    }));
    if (posts.length === 0) return;
    try {
        const res = await fetch(ingestUrl, {
            method: "POST",
            headers: {
                "content-type": "application/json",
                "x-ingest-secret": ingestSecret || "",
            },
            body: JSON.stringify({ posts }),
        });
        const body = await res.text();
        console.log(`Ingest response: ${res.status} ${body}`);
    } catch (err) {
        console.log("Error forwarding to ingest:", err);
    }
}

const sendTelegram = async (apiToken, chatId, message) => {
    if (!apiToken || !chatId) return;
    try {
        const url = `https://api.telegram.org/bot${apiToken}/sendMessage`;
        await fetch(url, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ chat_id: chatId, text: message }),
        });
    } catch (err) {
        console.log("Telegram send error:", err);
    }
}

const scrape = async (topic, url) => {
    const apiToken = process.env.API_TOKEN || config.telegramApiToken;
    const chatId = process.env.CHAT_ID || config.chatId;
    const telegramEnabled = !!(apiToken && chatId);
    try {
        if (telegramEnabled) {
            await sendTelegram(apiToken, chatId, `Starting scanning ${topic} on link:\n${url}`);
        } else {
            console.log(`Starting scanning ${topic} on link:\n${url}`);
        }
        const scrapeResults = await scrapeItemsAndExtractData(url);
        console.log(`Found ${scrapeResults.length} items on page`);
        const newItems = await checkIfHasNewItems(scrapeResults, topic);
        console.log(`${newItems.length} new items for topic "${topic}"`);
        if (newItems.length > 0) {
            // Forward new listings to Dira Finder ingest
            await forwardToIngest(newItems, url);
            if (telegramEnabled) {
                const newItemsJoined = newItems.map(i => i.postUrl || i.imgSrc).join("\n----------\n");
                const msg = `${newItems.length} new items:\n${newItemsJoined}`;
                await sendTelegram(apiToken, chatId, msg);
            }
        } else {
            if (telegramEnabled) {
                await sendTelegram(apiToken, chatId, "No new items were added");
            } else {
                console.log("No new items were added");
            }
        }
    } catch (e) {
        let errMsg = e?.message || "";
        if (errMsg) {
            errMsg = `Error: ${errMsg}`
        }
        console.log(`Scan workflow failed for ${topic}: ${errMsg}`);
        if (telegramEnabled) {
            await sendTelegram(apiToken, chatId, `Scan workflow failed... ${errMsg}`);
        }
        throw new Error(e)
    }
}

const program = async () => {
    await Promise.all(config.projects.filter(project => {
        if (project.disabled) {
            console.log(`Topic "${project.topic}" is disabled. Skipping.`);
        }
        return !project.disabled;
    }).map(async project => {
        await scrape(project.topic, project.url)
    }))
};

program();
