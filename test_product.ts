import { makeWpClient, getConfig } from './src/cli.ts';
import fs from 'node:fs';

async function test() {
  const config = getConfig({ needWp: true, needSftp: false });
  const wp = makeWpClient(config);
  try {
    const items = await wp.fetchProductsPage(1, 1);
    if (items.length > 0) {
      fs.writeFileSync('product_dump.json', JSON.stringify(items[0], null, 2));
      console.log('Saved to product_dump.json');
    }
  } catch (e) {
    console.error("Error fetching product:", e);
  }
}
test();
