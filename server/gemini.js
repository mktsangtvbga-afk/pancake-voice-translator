/**
 * Gemini wrapper: Speech-to-Text + language detection + Vietnamese
 * translation in a single multimodal call, constrained to a strict JSON
 * schema so the caller never has to guess at Gemini's formatting.
 */
const { GoogleGenAI } = require('@google/genai');

const MODEL = process.env.GEMINI_MODEL || 'gemini-2.5-flash';
// Confirmed live: plain text calls return in ~1-4s even with audio attached
// (30KB clip: 3.8s), but occasionally a call just hangs for the full
// duration with no response at all (77KB clip: hung 90s straight) — this
// looks like a stuck/dead keep-alive connection rather than Gemini actually
// being slow, so we keep the per-attempt timeout modest and retry with a
// fresh connection instead of waiting even longer on a call that likely
// isn't coming back.
const TIMEOUT_MS = Number(process.env.GEMINI_TIMEOUT_MS || 45000);
const MAX_ATTEMPTS = 2;

const SYSTEM_PROMPT = `Bạn là hệ thống nhận dạng và dịch voice message chuyên dùng cho hội thoại bán hàng.

Nhiệm vụ:

1. Nghe toàn bộ audio.
2. Chuyển lời nói thành văn bản gốc chính xác nhất có thể.
3. GIỮ NGUYÊN ngôn ngữ gốc trong transcript.
4. Xác định ngôn ngữ chính của người nói.
5. Dịch sang tiếng Việt tự nhiên, đúng ngữ cảnh hội thoại.
6. Không thêm, không suy diễn, không tự ý bổ sung thông tin không có trong audio.

Quy tắc:

- transcript phải giữ nguyên nội dung người nói.
- Không dịch trong trường transcript.
- translation phải là bản dịch tiếng Việt.
- Nếu có nhiều người nói, gộp thành một transcript duy nhất theo thứ tự xuất hiện.
- Nếu audio chứa tiếng lóng, từ viết tắt hoặc lỗi phát âm, hãy suy luận hợp lý nhưng không bịa nội dung.
- Nếu không nghe rõ một phần, vẫn trả phần nghe được.
- Ưu tiên hiểu ngữ cảnh thương mại điện tử, bán hàng, giao hàng, xác nhận đơn, đổi trả, thanh toán, màu sắc, kích thước, địa chỉ nhận hàng, COD và các hội thoại chăm sóc khách hàng bằng tiếng Khmer.
- Khi dịch, ưu tiên truyền tải đúng ý nghĩa thực tế trong ngữ cảnh mua bán thay vì dịch từng từ một cách máy móc.
- Tên riêng, số điện thoại, mã đơn hàng, địa chỉ, tên sản phẩm và số lượng phải được giữ nguyên chính xác.
- Nếu audio hoàn toàn không có lời nói, chỉ có nhạc, tiếng ồn hoặc quá mờ để nhận dạng:
  - sourceLanguage = "unknown"
  - transcript = ""
  - translation = ""

Ngôn ngữ:

- Khmer => "km"
- Vietnamese => "vi"
- English => "en"
- Thai => "th"
- Chinese => "zh"
- Lao => "lo"

Yêu cầu đầu ra:

- Chỉ trả về JSON hợp lệ.
- Không trả về markdown.
- Không thêm giải thích.
- Không thêm văn bản ngoài JSON.

Schema:

{
  "sourceLanguage": "string",
  "confidence": 0.0,
  "transcript": "string",
  "translation": "string"

}
  Phần lớn audio đến từ khách hàng Campuchia đang trao đổi về mua hàng trực tuyến. Hãy ưu tiên nhận dạng tiếng Khmer và diễn giải theo ngữ cảnh bán hàng thực tế nếu câu nói ngắn, thiếu chủ ngữ hoặc sử dụng cách nói địa phương.
`;

// Gemini's Schema type uses OpenAPI-style uppercase type names (STRING,
// OBJECT, ...), not JSON Schema's lowercase ones — see the `Type` enum in
// @google/genai's type defs.
const RESPONSE_SCHEMA = {
  type: 'OBJECT',
  properties: {
    sourceLanguage: { type: 'STRING', description: 'Mã ngôn ngữ gốc, ví dụ km, en, th, vi, unknown' },
    transcript: { type: 'STRING', description: 'Văn bản gốc được nhận dạng từ audio' },
    translation: { type: 'STRING', description: 'Bản dịch tiếng Việt' },
  },
  required: ['sourceLanguage', 'transcript', 'translation'],
};

let client = null;
function getClient() {
  if (!process.env.GEMINI_API_KEY) {
    throw Object.assign(new Error('Server chưa cấu hình GEMINI_API_KEY.'), { code: 'NO_API_KEY' });
  }
  if (!client) {
    client = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
  }
  return client;
}

function withTimeout(promise, ms) {
  return Promise.race([
    promise,
    new Promise((_, reject) =>
      setTimeout(() => reject(Object.assign(new Error('Gemini timeout.'), { code: 'TIMEOUT' })), ms)
    ),
  ]);
}

function extractJson(text) {
  try {
    return JSON.parse(text);
  } catch (_err) {
    const match = text && text.match(/\{[\s\S]*\}/);
    if (match) {
      try {
        return JSON.parse(match[0]);
      } catch (_err2) {
        // fall through
      }
    }
    throw Object.assign(new Error('Gemini trả về dữ liệu không đúng định dạng JSON.'), { code: 'BAD_RESPONSE' });
  }
}

// Voice notes from some chat CDNs are audio-only but mislabeled as a video
// container (confirmed live: Messenger serves them as "video/mp4" with no
// video track — Gemini's video pipeline then rejects them with "0 Frames
// found"). This endpoint only ever handles voice messages, so relabel any
// video/* mimetype to the equivalent audio/* one to route it through
// Gemini's audio understanding instead.
function normalizeAudioMimeType(mimeType) {
  if (!mimeType) return 'audio/mp4';
  if (mimeType.startsWith('video/')) return mimeType.replace('video/', 'audio/');
  return mimeType;
}

/**
 * @param {Buffer} audioBuffer
 * @param {string} mimeType e.g. "audio/mpeg", "audio/ogg", "video/mp4" (audio-only, will be normalized)
 * @returns {Promise<{sourceLanguage: string, transcript: string, translation: string}>}
 */
function classifyGeminiError(err) {
  if (err.code === 'TIMEOUT') return err;
  const status = err.status || err.statusCode || (err.response && err.response.status);
  if (status === 429) {
    return Object.assign(new Error('Gemini quota exceeded.'), { code: 'QUOTA_EXCEEDED', cause: err });
  }
  if (status === 401 || status === 403) {
    return Object.assign(new Error('Gemini API key không hợp lệ hoặc không có quyền.'), { code: 'AUTH_ERROR', cause: err });
  }
  if (status === 400) {
    return Object.assign(new Error(`Gemini từ chối request: ${err.message || err}`), { code: 'GEMINI_ERROR', cause: err });
  }
  return Object.assign(new Error(`Gemini lỗi: ${err.message || err}`), { code: 'GEMINI_ERROR', cause: err });
}

/** True for errors worth retrying with a fresh connection (timeouts, transient network blips) — not auth/quota/bad-request, which will just fail the same way again. */
function isRetryable(classifiedErr) {
  return classifiedErr.code === 'TIMEOUT' || classifiedErr.code === 'GEMINI_ERROR';
}

async function callGeminiOnce(ai, audioBuffer, normalizedMimeType, mimeType, attempt) {
  const startedAt = Date.now();
  console.log(
    `[gemini] gọi generateContent (lần ${attempt}/${MAX_ATTEMPTS}): ${audioBuffer.length} bytes, mimeType=${normalizedMimeType} (gốc: ${mimeType})`
  );
  try {
    const response = await withTimeout(
      ai.models.generateContent({
        model: MODEL,
        contents: [
          {
            role: 'user',
            parts: [
              { text: SYSTEM_PROMPT },
              { inlineData: { mimeType: normalizedMimeType, data: audioBuffer.toString('base64') } },
            ],
          },
        ],
        config: {
          responseMimeType: 'application/json',
          responseSchema: RESPONSE_SCHEMA,
          temperature: 0.2,
        },
      }),
      TIMEOUT_MS
    );
    console.log(`[gemini] generateContent xong sau ${Date.now() - startedAt}ms (lần ${attempt})`);
    return response;
  } catch (err) {
    console.log(`[gemini] generateContent lỗi sau ${Date.now() - startedAt}ms (lần ${attempt}): ${err.message}`);
    throw classifyGeminiError(err);
  }
}

async function transcribeAndTranslate(audioBuffer, mimeType) {
  const ai = getClient();
  const normalizedMimeType = normalizeAudioMimeType(mimeType);

  let response;
  let lastErr;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    try {
      response = await callGeminiOnce(ai, audioBuffer, normalizedMimeType, mimeType, attempt);
      lastErr = null;
      break;
    } catch (err) {
      lastErr = err;
      if (attempt >= MAX_ATTEMPTS || !isRetryable(err)) break;
    }
  }
  if (lastErr) throw lastErr;

  const text = typeof response.text === 'function' ? response.text() : response.text;
  const parsed = extractJson(text);

  return {
    sourceLanguage: String(parsed.sourceLanguage || 'unknown'),
    transcript: String(parsed.transcript || ''),
    translation: String(parsed.translation || ''),
  };
}

module.exports = { transcribeAndTranslate };
