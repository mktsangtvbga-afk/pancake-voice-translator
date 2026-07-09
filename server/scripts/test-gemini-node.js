// So sanh: goi Gemini bang Node fetch() thuan (Test 1) vs qua SDK @google/genai
// (Test 2, giong het cach server that su dung). Neu Test 1 nhanh nhung Test 2
// treo => loi nam trong SDK. Neu ca hai deu treo nhung PowerShell/curl truoc
// do lai nhanh => loi mang/proxy chi anh huong rieng toi tien trinh Node.
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const key = process.env.GEMINI_API_KEY;
if (!key) {
  console.log('Khong tim thay GEMINI_API_KEY trong .env');
  process.exit(1);
}
console.log(`Do dai key: ${key.length} | bat dau bang: ${key.slice(0, 6)}...`);

async function testRawFetch() {
  console.log('\n--- Test 1: Node fetch() truc tiep (khong qua SDK) ---');
  const start = Date.now();
  try {
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${key}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ contents: [{ parts: [{ text: 'Say hi in one word' }] }] }),
        signal: AbortSignal.timeout(15000),
      }
    );
    const json = await res.json();
    console.log(`OK sau ${Date.now() - start}ms, HTTP ${res.status}`);
    console.log(JSON.stringify(json).slice(0, 300));
  } catch (err) {
    console.log(`LOI sau ${Date.now() - start}ms:`, err.message);
  }
}

async function testSdk() {
  console.log('\n--- Test 2: Qua @google/genai SDK (giong server that dung) ---');
  const { GoogleGenAI } = require('@google/genai');
  const ai = new GoogleGenAI({ apiKey: key });
  const start = Date.now();
  try {
    const res = await Promise.race([
      ai.models.generateContent({
        model: 'gemini-2.5-flash',
        contents: [{ role: 'user', parts: [{ text: 'Say hi in one word' }] }],
      }),
      new Promise((_, reject) => setTimeout(() => reject(new Error('timeout 15s (test tu dat, khong phai loi that)')), 15000)),
    ]);
    console.log(`OK sau ${Date.now() - start}ms`);
    console.log(typeof res.text === 'function' ? res.text() : res.text);
  } catch (err) {
    console.log(`LOI sau ${Date.now() - start}ms:`, err.message);
  }
}

(async () => {
  await testRawFetch();
  await testSdk();
})();
