const axios = require('axios');
const { HttpsProxyAgent } = require('https-proxy-agent');
const fs = require('fs');

const proxyAgent = process.env.HTTPS_PROXY ? new HttpsProxyAgent(process.env.HTTPS_PROXY) : undefined;

async function test() {
    const wpBaseUrl = process.env.WP_BASE_URL || "https://your-site.com/wp-json";
    // For safety
    const ck = process.env.WC_CONSUMER_KEY || "";
    const cs = process.env.WC_CONSUMER_SECRET || "";

    const client = axios.create({
        baseURL: wpBaseUrl,
        httpsAgent: proxyAgent
    });

    try {
        const res = await client.get(`/wc/v3/products`, {
            params: { consumer_key: ck, consumer_secret: cs, per_page: 5, search: "S912" }
        });
        const items = res.data;
        if (items.length > 0) {
            fs.writeFileSync('test_meta_dump.json', JSON.stringify(items[0].meta_data, null, 2));
            console.log('Saved to test_meta_dump.json');
        } else {
            console.log('No item found');
        }
    } catch (e) {
        console.error(e.response?.data || e.message);
    }
}
test();
