const axios = require('axios');
const { HttpsProxyAgent } = require('https-proxy-agent');
const qs = require('querystring');
require('dotenv').config();

// Get configured proxy if present
const proxyAgent = process.env.HTTPS_PROXY ? new HttpsProxyAgent(process.env.HTTPS_PROXY) : undefined;

async function test() {
  const wpBaseUrl = process.env.WP_BASE_URL || "https://your-site.com/wp-json";
  const ck = process.env.WC_CONSUMER_KEY || "";
  const cs = process.env.WC_CONSUMER_SECRET || "";

  const client = axios.create({
    baseURL: wpBaseUrl,
    httpsAgent: proxyAgent
  });

  const queryParams = {
      consumer_key: ck,
      consumer_secret: cs,
      page: 1,
      per_page: 2
  };
  
  try {
      const res = await client.get(`/wc/v3/products?${qs.stringify(queryParams)}`);
      const items = res.data;
      if (items.length > 0) {
        console.log('meta_data:', JSON.stringify(items[0].meta_data, null, 2));
      }
  } catch (e) {
      console.error(e.response?.data || e.message);
  }
}
test();
