# Pancake Voice Translator

Chrome/Cốc Cốc extension dịch voice message trên [Pancake](https://pancake.vn) sang tiếng Việt bằng Gemini, và đọc lại bản dịch bằng giọng tiếng Việt.

```
/extension   Chrome Extension (Manifest V3)
/server      Backend Node.js/Express — nơi duy nhất giữ Gemini API key
```

## ⚠️ Giả định quan trọng — đọc trước khi dùng

Tôi không có quyền truy cập trình duyệt để đăng nhập và soi DOM thật của Pancake, nên các điểm sau là **giả định có chủ đích**, không phải đã verify trên Pancake thật:

1. **Domain Pancake**: `manifest.json` match cả `https://pancake.vn/*`, `https://*.pancake.vn/*` (đã xác nhận qua ảnh chụp thực tế — giao diện chat nằm ở `pancake.vn/multi_pages`) lẫn `https://pages.fm/*`, `https://*.pages.fm/*` (phòng trường hợp một số tài khoản dùng domain này). Nếu team bạn dùng domain/subdomain khác nữa, thêm vào `matches` trong `manifest.json` (2 chỗ) và `PANCAKE_HOST_RE` trong `extension/providers/pancake-provider.js`.

   **CDN chứa file audio thật — đã xác nhận cần khai riêng**: Pancake là inbox đa kênh (Facebook/Zalo/Shopee/TikTok/...), file voice message không nằm cùng domain với trang chat mà nằm trên CDN của từng kênh. Đã xác nhận thực tế: voice message từ Messenger trả về link dạng `https://cdn.fbsbx.com/...` — nên `host_permissions` đã thêm sẵn `https://*.fbsbx.com/*` và `https://*.fbcdn.net/*` để `fetch()` trong `background.js` không bị chặn kiểu CORS ("Failed to fetch"). Nếu bạn dùng thêm kênh khác (Zalo, Shopee, TikTok...), voice message của kênh đó sẽ nằm trên CDN riêng — thêm domain tương ứng vào `host_permissions`. Gợi ý: mở DevTools Console trên Pancake, tìm lỗi CSP (nếu có) — Pancake tự liệt kê toàn bộ domain CDN họ cho phép trong đó (ví dụ đã thấy `zadn.vn`, `zdn.vn` cho Zalo, `shopee.*.com` cho Shopee, `tiktokcdn.com` cho TikTok...), là danh sách gợi ý khá đáng tin để thêm dần khi cần.
2. **Cách nhận diện voice message**: thay vì hardcode class CSS (dễ vỡ khi Pancake đổi build), extension tìm mọi thẻ `<audio>` trên trang rồi suy ngược lên "bubble" chứa nó (xem `findBubbleAncestor` trong `pancake-provider.js`). Đây là heuristic hợp lý cho hầu hết chat UI, nhưng **bạn nên mở DevTools trên Pancake thật, hover vào một voice message, xem cấu trúc DOM thực tế**, rồi tinh chỉnh nếu cần — xem mục "Tinh chỉnh selector" bên dưới.
3. **TTS**: dùng Edge Read Aloud (qua package `msedge-tts`) vì miễn phí, không cần API key. Muốn dùng Google Cloud TTS thay thế, chỉ cần sửa `server/tts.js` — phần còn lại của hệ thống không đổi.
4. **Gemini SDK**: dùng `@google/genai` (SDK chính thức mới của Google), model `gemini-2.5-flash`. Đã cài & kiểm tra `npm install` chạy được với `@google/genai@^2.10.0`.

Nếu inspect DOM thật thấy khác đáng kể (ví dụ voice message không dùng `<audio>` mà render bằng canvas/waveform riêng), báo lại — cần thêm một bước hook mạng sâu hơn (đã có sẵn `lib/network-hook.js` làm nền, chỉ cần mở rộng heuristic).

## 1. Cài đặt Backend

```bash
cd server
npm install
cp .env.example .env
```

Mở `.env`, điền:

```
GEMINI_API_KEY=<API key lấy tại https://aistudio.google.com/apikey>
PORT=5175
ALLOWED_ORIGINS=*          # tạm thời để test; xem bước "siết CORS" bên dưới
TTS_VOICE=vi-VN-HoaiMyNeural
```

Chạy server:

```bash
npm start
# hoặc: npm run dev   (tự restart khi sửa code, cần Node >= 18)
```

Kiểm tra:

```bash
curl http://localhost:5175/health
# {"ok":true,"geminiConfigured":true}
```

Đã test thực tế trong lúc build: `/health` và `/speak` (Edge TTS) chạy đúng, trả về mp3 hợp lệ. `/translate-audio` đã test nhánh lỗi (thiếu file, thiếu API key) — nhánh gọi Gemini thật cần bạn tự điền `GEMINI_API_KEY` để thử vì tôi không có key hợp lệ trong môi trường build.

### API

**POST /translate-audio** — `multipart/form-data`, field `audio` (file). Có thể kèm `audioUrl` để cache theo URL gốc (khuyến nghị).

```json
{ "sourceLanguage": "km", "transcript": "...", "translation": "...", "fromCache": false }
```

**POST /speak** — JSON `{ "text": "..." }` → trả về `audio/mpeg` (mp3).

**GET /health** — kiểm tra server + đã cấu hình Gemini key chưa.

### Cache

`server/cache.js` cache theo `SHA256(audio_url)` (hoặc theo bytes nếu không có URL), lưu ở `server/cache/store.json`, TTL 90 ngày. Xoá file này để reset toàn bộ cache dùng chung. Extension còn có cache riêng ở `chrome.storage.local` (xoá qua nút "Xoá cache" trong popup) để tránh gọi lại backend ngay cả khi offline.

### Siết CORS trước khi dùng thật

Sau khi load extension (bước 2) và có Extension ID, sửa `.env`:

```
ALLOWED_ORIGINS=chrome-extension://<extension-id>
```

rồi restart server. Việc này chặn các trang web khác gọi thẳng vào backend của bạn.

## 2. Cài đặt Extension (Chrome hoặc Cốc Cốc)

1. Vào `chrome://extensions` (Cốc Cốc: `browser://extensions`).
2. Bật **Chế độ dành cho nhà phát triển / Developer mode**.
3. Bấm **Tải tiện ích đã giải nén / Load unpacked**, chọn thư mục `extension/`.
4. Bấm icon extension → kiểm tra **Backend URL** (mặc định trỏ sẵn vào backend đã deploy trên Render — `https://pancake-voice-translator-backend.onrender.com`; đổi sang `http://localhost:5175` nếu bạn đang chạy backend local để dev/test) → **Lưu** → **Kiểm tra kết nối**.
5. Mở Pancake, vào một hội thoại có voice message, rê chuột vào audio → nút **Dịch** xuất hiện.

### Icon

Đã có sẵn `extension/icons/icon16.png`, `icon48.png`, `icon128.png` (nền xanh bo góc + biểu tượng sóng âm 3 vạch), sinh bằng `extension/scripts/generate-icons.js` — script tự dựng PNG bằng zlib thuần, không phụ thuộc thư viện ảnh nào. Icon này chỉ mang tính placeholder chức năng; nếu muốn logo riêng, thay trực tiếp 3 file PNG đó (giữ đúng tên + kích thước), hoặc sửa hàm `drawIcon()` trong script rồi chạy lại:

```bash
cd extension
node scripts/generate-icons.js
```

### Tương thích Cốc Cốc

Cốc Cốc dựa trên Chromium nên MV3 hoạt động bình thường. Có một điểm cần lưu ý: `manifest.json` dùng content script với `"world": "MAIN"` (để hook `fetch`/XHR của chính trang Pancake, phục vụ trường hợp voice URL không nằm sẵn trong `<audio src>`) — tính năng này cần Chromium ≥ 111. Nếu bản Cốc Cốc bạn dùng dựa trên Chromium cũ hơn, tính năng "Dịch" vẫn hoạt động cho voice message dùng `<audio src>` trực tiếp (đa số trường hợp), chỉ mất phần fallback qua network-hook.

### Tinh chỉnh selector (nếu DOM Pancake thực tế khác)

File duy nhất cần sửa: `extension/providers/pancake-provider.js`.

- `BUBBLE_ANCESTOR_HOPS` / `BUBBLE_HINT_RE`: điều chỉnh cách tìm "khung chứa" voice message để gắn nút Dịch vào đúng chỗ, không đè lên UI gốc.
- `extractAudioUrl`: đã xác nhận thực tế trên Pancake — thẻ `<audio>` render sẵn nhưng **không có `src` cho tới khi bấm Play** (lazy-load). Vì vậy `extractAudioUrl` giờ tự mô phỏng một click vào nút Play gốc của Pancake (ở chế độ `muted`, xem `triggerLazyLoad`/`findPlayTrigger`) để buộc nó tải audio, rồi pause + bỏ mute ngay khi lấy được `src` — người dùng không nghe thấy gì. `findPlayTrigger` chọn phần tử bằng heuristic (ưu tiên `aria-label`/class chứa "play", loại trừ nút tốc độ "1x" và nút download) vì không biết class thật của nút Play. Nếu nút Dịch vẫn báo "Không tìm thấy file audio" sau khi đã có `<audio>` trong DOM, nhiều khả năng `findPlayTrigger` đang chọn nhầm phần tử — mở DevTools, xem nút Play thật có `aria-label`/class gì rồi sửa `NON_PLAY_HINT_RE`/thứ tự chọn cho khớp.
- Nếu Pancake không set `src` qua `<audio>` mà tải hẳn qua API riêng (không liên quan tới nút Play), fallback tiếp theo là network-hook (`lib/network-hook.js` + `lib/network-bridge.js`) — đã viết sẵn, không cần code thêm, chỉ cần kiểm tra response thực tế có khớp heuristic `looksLikeAudio()` không (URL đuôi `.mp3/.wav/.ogg/...` hoặc `Content-Type: audio/*`).

## 3. Dùng chung cho nhiều máy / đội làm việc từ xa

Đồng nghiệp không cùng mạng LAN với bạn thì cần: (a) một backend luôn bật, có địa chỉ public, và (b) cách CORS nhận diện đúng extension của mọi người dù mỗi người tự "Load unpacked" từ bản zip riêng.

### 3.1. Extension ID đã được khoá cố định

Extension load kiểu "Load unpacked" bình thường sẽ có ID ngẫu nhiên khác nhau trên mỗi máy (Chrome tính ID dựa trên đường dẫn thư mục), khiến không thể khoá CORS theo 1 ID được. Để xử lý việc này, tôi đã gắn sẵn field `"key"` vào `extension/manifest.json` — bất kỳ ai Load unpacked đúng bản zip này (không sửa field `key`) đều ra **cùng một Extension ID cố định**:

```
nipkhloneodlkfdldnakhlmnhbjfjbbn
```

File `extension/extension-key.pem` là private key tương ứng — **giữ riêng tư, đừng chia sẻ công khai** (đã thêm vào `extension/.gitignore`). Không cần dùng đến file này trong vận hành bình thường; chỉ cần giữ lại phòng khi sau này muốn tự ký `.crx` thủ công.

> Lưu ý: nếu sau này publish lên Chrome Web Store (mục 6), Store sẽ cấp một ID **khác** cho lần đăng đầu tiên bất kể field `key` này — lúc đó cần cập nhật lại `ALLOWED_ORIGINS` trên backend theo ID mới do Store cấp.

### 3.2. Deploy backend lên server public

Ví dụ dùng [Render.com](https://render.com) (có free tier, không cần thẻ với gói cơ bản; Railway/Fly.io/một VPS bất kỳ đều làm tương tự):

1. Đẩy code (ít nhất thư mục `server/`) lên một GitHub repo. `.env` đã có trong `server/.gitignore` nên sẽ không bị đẩy lên nhầm.
2. Trên Render: **New → Web Service** → connect tới repo đó.
   - **Root Directory**: `server`
   - **Build Command**: `npm install`
   - **Start Command**: `npm start`
3. Vào tab **Environment**, thêm các biến (giá trị lấy từ `server/.env.example`):
   ```
   GEMINI_API_KEY=<key thật>
   TTS_VOICE=vi-VN-HoaiMyNeural
   ALLOWED_ORIGINS=chrome-extension://nipkhloneodlkfdldnakhlmnhbjfjbbn
   MAX_AUDIO_BYTES=15728640
   ```
   Không cần set `PORT` — Render tự inject biến `PORT`, và `server.js` đã đọc `process.env.PORT` sẵn.
4. Deploy xong sẽ có domain dạng `https://ten-app.onrender.com`. Test bằng `curl https://ten-app.onrender.com/health`.
5. Gói free của Render/Railway thường "ngủ" sau một khoảng không có traffic — request đầu tiên sau khi ngủ sẽ chậm (10-30s cold start). Nếu cần phản hồi tức thời liên tục, cân nhắc gói trả phí thấp nhất hoặc một VPS nhỏ luôn chạy.

### 3.3. Phân phối extension cho từng máy

1. Nén thư mục `extension/` (giữ nguyên, đừng đổi field `key` trong `manifest.json`) thành zip, gửi cho đồng nghiệp.
2. Mỗi người: `chrome://extensions` → bật Developer mode → **Load unpacked** → chọn thư mục đã giải nén.
3. Mỗi người bấm icon extension → nhập **Backend URL** = domain Render ở bước 3.2 (ví dụ `https://ten-app.onrender.com`) → **Lưu** → **Kiểm tra kết nối**.

Từ giờ mọi máy đều gọi chung 1 backend, dùng chung 1 Gemini API key (không lộ ra máy client nào), và dùng chung cache phía server (`server/cache/store.json`) — voice message ai đó đã dịch rồi, người khác mở lại không tốn thêm lượt gọi Gemini.

Cập nhật code sau này: bạn sửa lại `extension/` → nén zip mới → gửi lại → từng người Load unpacked đè lên (hoặc Remove rồi Load unpacked lại). Đây là giới hạn của cách phân phối thủ công; nếu muốn tự động cập nhật cho mọi người, cần publish lên Chrome Web Store (mục 6) — lúc đó Chrome tự cập nhật extension nền, không cần gửi lại zip.

## 4. Kiến trúc Adapter (mở rộng sang Facebook/Zalo/Telegram/WhatsApp)

```
extension/providers/audio-provider.js   AudioProvider (interface) + ProviderRegistry
extension/providers/pancake-provider.js PancakeProvider (implementation hiện có)
```

Thêm platform mới = tạo 1 file mới, ví dụ `extension/providers/facebook-provider.js`:

```js
(function (global) {
  class FacebookProvider extends global.PVT.AudioProvider {
    get id() { return 'facebook'; }
    matches(location) { return /(^|\.)facebook\.com$/.test(location.hostname); }
    detectAudioElements(root) { /* ... */ }
    extractAudioUrl(container) { /* ... */ }
  }
  global.PVT.registry.register(new FacebookProvider());
})(window);
```

rồi thêm file đó + một entry `content_scripts` (matches domain tương ứng) vào `manifest.json`. `content.js`, `background.js`, popup, backend — **không cần sửa gì**, vì toàn bộ phần đó chỉ nói chuyện qua interface `AudioProvider`.

## 5. Build để đóng gói

Extension này không cần bundler (thuần JS, không import ES module) — "build" chỉ là zip thư mục `extension/`:

```bash
cd extension
# Windows PowerShell:
Compress-Archive -Path * -DestinationPath ../pancake-voice-translator.zip -Force
```

Trước khi zip: đảm bảo đã thêm icon PNG (mục 2), và đã trỏ Backend URL production trong code/README cho người dùng cuối tự nhập ở popup (đừng hardcode localhost).

## 6. Publish lên Chrome Web Store

1. Tạo tài khoản nhà phát triển tại https://chrome.google.com/webstore/devconsole (phí một lần ~$5).
2. **New item** → upload `pancake-voice-translator.zip`.
3. Điền: mô tả, ảnh chụp màn hình (bắt buộc ít nhất 1), icon 128×128, privacy policy URL (bắt buộc vì extension gửi dữ liệu audio ra ngoài — giải thích rõ trong policy: audio được gửi tới backend riêng của bạn rồi tới Gemini API để dịch, không tới bên thứ ba nào khác).
4. Mục **Permissions justification**: giải thích `host_permissions` cho `pages.fm` là để đọc voice message trong Pancake; `optional_host_permissions: *://*/*` (nếu bạn giữ lại) cần giải thích rõ mục đích mở rộng sang nền tảng khác — nếu chưa dùng, có thể **xoá bỏ** dòng này khỏi `manifest.json` để review nhanh hơn.
5. Submit for review. Chrome Web Store review có thể mất vài ngày, đặc biệt với extension đọc nội dung trang (`host_permissions`).

**Cốc Cốc**: không có store công khai tương đương cho mọi extension bên thứ ba theo cùng quy trình Chrome Web Store; cách phổ biến là phân phối nội bộ qua "Load unpacked" (mục 2) hoặc qua Cốc Cốc Extension Store nếu công ty bạn đã có tài khoản đối tác — quy trình đó nằm ngoài phạm vi Chrome Web Store nên cần liên hệ Cốc Cốc trực tiếp nếu muốn niêm yết công khai.

## 7. Bảo mật

- Gemini API key **chỉ** tồn tại trong `server/.env`, không bao giờ nằm trong code của extension (extension chỉ biết `backendUrl`).
- `server.js` giới hạn kích thước upload (`MAX_AUDIO_BYTES`, mặc định 15MB), rate-limit theo IP (`express-rate-limit`), và validate MIME type audio.
- CORS nên siết về đúng `chrome-extension://<id>` trước khi dùng thật (mục 1).
- `.env` đã có trong `server/.gitignore` — đừng commit nó.

## 8. Xử lý lỗi đã implement

| Tình huống | Xử lý |
|---|---|
| Audio không tồn tại / link hết hạn | `background.js` báo lỗi rõ ràng ("Không tải được audio gốc...") trước khi gọi backend |
| Gemini timeout | `gemini.js` timeout sau `GEMINI_TIMEOUT_MS` (mặc định 45s) → HTTP 504 |
| Gemini quota exceeded | Map HTTP 429 từ Gemini → trả về 429 kèm thông báo tiếng Việt |
| Gemini trả JSON hỏng | `extractJson()` cố gắng bóc JSON từ text trước khi throw lỗi rõ ràng |
| TTS lỗi / text rỗng / quá dài | `tts.js` phân loại lỗi (`EMPTY_TEXT`, `TEXT_TOO_LONG`, `TIMEOUT`, `TTS_ERROR`) → HTTP tương ứng |
| Backend không chạy / sai URL | Popup có nút "Kiểm tra kết nối"; nút Dịch/Nghe hiển thị lỗi ngay trong panel thay vì im lặng fail |
