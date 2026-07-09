/**
 * Text-to-Speech via Microsoft Edge's "Read Aloud" service (free, no API
 * key). Swap this module for Google Cloud TTS if you'd rather pay for an
 * SLA — the rest of the server only depends on `synthesizeVietnamese(text)`
 * resolving to an mp3 Buffer, so no other file needs to change.
 */
const { MsEdgeTTS, OUTPUT_FORMAT } = require('msedge-tts');

const VOICE = process.env.TTS_VOICE || 'vi-VN-HoaiMyNeural';
const MAX_CHARS = 4000;
const TIMEOUT_MS = Number(process.env.TTS_TIMEOUT_MS || 20000);

function withTimeout(promise, ms) {
  return Promise.race([
    promise,
    new Promise((_, reject) =>
      setTimeout(() => reject(Object.assign(new Error('TTS timeout.'), { code: 'TIMEOUT' })), ms)
    ),
  ]);
}

async function streamToBuffer(stream) {
  const chunks = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

/**
 * @param {string} text Vietnamese text to speak.
 * @returns {Promise<Buffer>} mp3 audio bytes.
 */
async function synthesizeVietnamese(text) {
  const clean = (text || '').trim();
  if (!clean) {
    throw Object.assign(new Error('Không có nội dung để đọc.'), { code: 'EMPTY_TEXT' });
  }
  if (clean.length > MAX_CHARS) {
    throw Object.assign(
      new Error(`Bản dịch quá dài để đọc (>${MAX_CHARS} ký tự).`),
      { code: 'TEXT_TOO_LONG' }
    );
  }

  try {
    const tts = new MsEdgeTTS();
    await withTimeout(
      tts.setMetadata(VOICE, OUTPUT_FORMAT.AUDIO_24KHZ_48KBITRATE_MONO_MP3),
      TIMEOUT_MS
    );
    const { audioStream } = tts.toStream(clean);
    const buffer = await withTimeout(streamToBuffer(audioStream), TIMEOUT_MS);
    if (!buffer.length) {
      throw Object.assign(new Error('TTS trả về audio rỗng.'), { code: 'EMPTY_AUDIO' });
    }
    return buffer;
  } catch (err) {
    if (err.code === 'TIMEOUT' || err.code === 'EMPTY_AUDIO') throw err;
    throw Object.assign(new Error(`TTS lỗi: ${err.message || err}`), { code: 'TTS_ERROR', cause: err });
  }
}

module.exports = { synthesizeVietnamese };
