require('dotenv').config();

const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const multer = require('multer');
const rateLimit = require('express-rate-limit');

const gemini = require('./gemini');
const tts = require('./tts');
const cache = require('./cache');

const PORT = Number(process.env.PORT || 5175);
const MAX_AUDIO_BYTES = Number(process.env.MAX_AUDIO_BYTES || 15 * 1024 * 1024);
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || '*').split(',').map((s) => s.trim()).filter(Boolean);

const app = express();
app.disable('x-powered-by');
app.use(helmet());
app.use(express.json({ limit: '256kb' }));

app.use(
  cors({
    origin(origin, callback) {
      // Non-browser tools (curl, health checks) send no Origin header.
      if (!origin) return callback(null, true);
      if (ALLOWED_ORIGINS.includes('*') || ALLOWED_ORIGINS.includes(origin)) {
        return callback(null, true);
      }
      return callback(new Error('Origin không được phép.'));
    },
  })
);

// Gemini calls are the expensive resource here — cap per-IP request rate
// independently of any upstream Gemini quota.
const translateLimiter = rateLimit({ windowMs: 60 * 1000, max: 20, standardHeaders: true, legacyHeaders: false });
const speakLimiter = rateLimit({ windowMs: 60 * 1000, max: 30, standardHeaders: true, legacyHeaders: false });

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_AUDIO_BYTES },
  fileFilter(_req, file, cb) {
    // Voice notes from chat platforms often arrive wrapped in a video
    // container (confirmed live: Messenger serves them as "video/mp4" even
    // though the payload is audio-only), so audio/* alone is too strict —
    // accept video/* too and let Gemini's own multimodal understanding
    // handle the container.
    const mime = file.mimetype || '';
    const isMediaLike = mime.startsWith('audio/') || mime.startsWith('video/') || mime === 'application/octet-stream';
    if (!isMediaLike) {
      return cb(Object.assign(new Error('File không phải định dạng audio/video được hỗ trợ.'), { code: 'INVALID_MIME' }));
    }
    cb(null, true);
  },
});

app.get('/health', (_req, res) => {
  res.json({ ok: true, geminiConfigured: Boolean(process.env.GEMINI_API_KEY) });
});

app.post('/translate-audio', translateLimiter, upload.single('audio'), async (req, res) => {
  try {
    if (!req.file || !req.file.buffer || !req.file.buffer.length) {
      return res.status(400).json({ error: 'Thiếu file audio.' });
    }

    const audioUrl = (req.body.audioUrl || '').trim();
    const clientHash = (req.body.audioHash || '').trim();
    const hash = cache.computeHash({ audioUrl: audioUrl || null, audioHash: clientHash || null, buffer: req.file.buffer });

    const cached = cache.get(hash);
    if (cached) {
      return res.json({
        sourceLanguage: cached.sourceLanguage,
        transcript: cached.transcript,
        translation: cached.translation,
        fromCache: true,
      });
    }

    const result = await gemini.transcribeAndTranslate(req.file.buffer, req.file.mimetype);
    cache.set(hash, result);

    return res.json({ ...result, fromCache: false });
  } catch (err) {
    return res.status(statusForError(err)).json({ error: messageForError(err) });
  }
});

app.post('/speak', speakLimiter, async (req, res) => {
  try {
    const text = (req.body && req.body.text) || '';
    const buffer = await tts.synthesizeVietnamese(text);
    res.setHeader('Content-Type', 'audio/mpeg');
    res.setHeader('Content-Length', String(buffer.length));
    return res.send(buffer);
  } catch (err) {
    return res.status(statusForError(err)).json({ error: messageForError(err) });
  }
});

function statusForError(err) {
  switch (err && err.code) {
    case 'NO_API_KEY':
    case 'AUTH_ERROR':
      return 500;
    case 'QUOTA_EXCEEDED':
      return 429;
    case 'TIMEOUT':
      return 504;
    case 'INVALID_MIME':
    case 'EMPTY_TEXT':
    case 'TEXT_TOO_LONG':
      return 400;
    case 'LIMIT_FILE_SIZE':
      return 413;
    default:
      return 500;
  }
}

function messageForError(err) {
  if (err && err.code === 'LIMIT_FILE_SIZE') return 'File audio vượt quá giới hạn cho phép.';
  return (err && err.message) || 'Lỗi không xác định.';
}

// Errors thrown inside multer's own processing (LIMIT_FILE_SIZE, our custom
// fileFilter rejection, ...) arrive via next(err) before ever reaching the
// route handler's own try/catch, so they need their own middleware here —
// anything carrying a recognized `.code` gets mapped the same way the route
// handlers do, instead of collapsing into a generic 500.
app.use((err, _req, res, _next) => {
  if (err instanceof multer.MulterError || (err && err.code)) {
    return res.status(statusForError(err)).json({ error: messageForError(err) });
  }
  console.error('[server] unhandled error:', err);
  return res.status(500).json({ error: 'Lỗi server không xác định.' });
});

app.listen(PORT, () => {
  console.log(`Pancake Voice Translator backend đang chạy tại http://localhost:${PORT}`);
  if (!process.env.GEMINI_API_KEY) {
    console.warn('[server] CẢNH BÁO: chưa cấu hình GEMINI_API_KEY trong .env');
  }
});
