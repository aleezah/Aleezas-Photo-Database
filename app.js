require('dotenv').config();
const express = require('express');
const Database = require('better-sqlite3');
const sharp = require('sharp');
const path = require('path');
const crypto = require('crypto');
const fs = require('fs');
const { exec, execFile, spawn } = require('child_process');
const { ZipArchive } = require('archiver');
const ffmpegPath = require('ffmpeg-static');

const compressProgress = new Map();

function getDuration(filePath) {
  return new Promise(resolve => {
    execFile(ffmpegPath, ['-i', filePath], (_err, _stdout, stderr) => {
      const m = stderr.match(/Duration: (\d+):(\d+):(\d+\.?\d*)/);
      if (m) resolve(parseFloat(m[1]) * 3600 + parseFloat(m[2]) * 60 + parseFloat(m[3]));
      else resolve(0);
    });
  });
}

function spawnFfmpeg(args, photoId, totalSecs) {
  return new Promise((resolve, reject) => {
    const proc = spawn(ffmpegPath, ['-progress', 'pipe:1', ...args]);
    let buf = '';
    proc.stdout.on('data', chunk => {
      buf += chunk.toString();
      const lines = buf.split('\n');
      buf = lines.pop();
      for (const line of lines) {
        const eq = line.indexOf('=');
        if (eq < 0) continue;
        const key = line.slice(0, eq).trim();
        const val = line.slice(eq + 1).trim();
        if (key === 'out_time_ms') {
          const ms = parseInt(val, 10);
          if (isNaN(ms) || ms < 0) continue;
          const pct = totalSecs > 0 ? Math.min(99, (ms / 1000 / totalSecs) * 100) : 0;
          const prev = compressProgress.get(photoId) || {};
          compressProgress.set(photoId, { ...prev, pct: Math.round(pct) });
        } else if (key === 'speed') {
          const speed = parseFloat(val);
          if (isNaN(speed) || speed <= 0) continue;
          const prev = compressProgress.get(photoId) || { pct: 0 };
          const doneSecs = (prev.pct / 100) * totalSecs;
          const eta = totalSecs > 0 ? Math.round((totalSecs - doneSecs) / speed) : null;
          compressProgress.set(photoId, { ...prev, speed: speed.toFixed(1) + 'x', eta });
        }
      }
    });
    proc.on('close', code => {
      compressProgress.delete(photoId);
      if (code === 0) resolve();
      else reject(new Error(`ffmpeg exited with code ${code}`));
    });
  });
}

// ── Immich API helper ─────────────────────────────────────────────────────────
const IMMICH_URL = (process.env.IMMICH_URL || 'http://localhost:2283').replace(/\/$/, '');
const IMMICH_KEY = process.env.IMMICH_API_KEY || '';

async function immichFetch(endpoint, options = {}) {
  return fetch(`${IMMICH_URL}${endpoint}`, {
    ...options,
    headers: { 'x-api-key': IMMICH_KEY, 'Content-Type': 'application/json', ...(options.headers || {}) },
  });
}

const BASE_DIR = __dirname;
const DB_PATH = path.join(BASE_DIR, 'film.db');
const THUMBS_DIR = path.join(BASE_DIR, 'thumbs');
fs.mkdirSync(THUMBS_DIR, { recursive: true });

const WEB_CACHE_DIR = path.join(THUMBS_DIR, 'web');
fs.mkdirSync(WEB_CACHE_DIR, { recursive: true });

const transcodingJobs = new Set();

function webCachePath(id) {
  return path.join(WEB_CACHE_DIR, `${id}.mp4`);
}

// ── startup migrations ────────────────────────────────────────────────────────
{
  const conn = new Database(DB_PATH);
  try { conn.exec('ALTER TABLE photos ADD COLUMN hidden INTEGER DEFAULT 0'); } catch {}
  try { conn.exec('ALTER TABLE rolls ADD COLUMN cover_photo_id INTEGER REFERENCES photos(id)'); } catch {}
  try { conn.exec('ALTER TABLE rolls ADD COLUMN hidden INTEGER DEFAULT 0'); } catch {}
  try { conn.exec('ALTER TABLE rolls ADD COLUMN share_token TEXT'); } catch {}
  try { conn.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_rolls_share_token ON rolls(share_token)'); } catch {}
  try { conn.exec('ALTER TABLE persons ADD COLUMN hidden INTEGER DEFAULT 0'); } catch {}
  try { conn.exec('ALTER TABLE photos ADD COLUMN immich_id TEXT'); } catch {}
  try { conn.exec('CREATE INDEX IF NOT EXISTS idx_photos_immich_id ON photos(immich_id)'); } catch {}
  try { conn.exec(`CREATE TABLE IF NOT EXISTS person_settings (
    immich_id TEXT PRIMARY KEY,
    is_hijabi INTEGER DEFAULT 0
  )`); } catch {}
  conn.exec(`
    CREATE TABLE IF NOT EXISTS faces (
      id        INTEGER PRIMARY KEY,
      photo_id  INTEGER NOT NULL REFERENCES photos(id),
      box_x     INTEGER, box_y INTEGER, box_w INTEGER, box_h INTEGER,
      embedding TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS persons (
      id            INTEGER PRIMARY KEY,
      name          TEXT,
      cover_face_id INTEGER REFERENCES faces(id)
    );
    CREATE TABLE IF NOT EXISTS face_persons (
      face_id   INTEGER NOT NULL REFERENCES faces(id),
      person_id INTEGER NOT NULL REFERENCES persons(id),
      PRIMARY KEY (face_id, person_id)
    );
    CREATE INDEX IF NOT EXISTS idx_faces_photo ON faces(photo_id);
  `);
  conn.close();
}

const app = express();
app.set('view engine', 'ejs');
app.set('views', path.join(BASE_DIR, 'views'));
app.use(express.json());
app.use('/static', express.static(path.join(BASE_DIR, 'static')));

// ── cookie parsing (no extra package) ────────────────────────────────────────
app.use((req, res, next) => {
  req.appCookies = {};
  (req.headers.cookie || '').split(';').forEach(c => {
    const eq = c.indexOf('=');
    if (eq > 0) req.appCookies[c.slice(0, eq).trim()] = decodeURIComponent(c.slice(eq + 1).trim());
  });
  res.locals.showHidden = req.appCookies.show_hidden === '1';
  next();
});

// ── template helpers ──────────────────────────────────────────────────────────
app.locals.fmt = n => (n || 0).toLocaleString();
app.locals.rollLabel = rel => rel === '.' ? '' : rel.replace(/\\/g, ' › ');
app.locals.rollLeaf = rel => {
  const parts = (rel || '').split(/[/\\]/);
  return parts[parts.length - 1] || rel;
};

// ── db / file helpers ─────────────────────────────────────────────────────────

function db() { return new Database(DB_PATH); }

function thumbFor(filePath) {
  const h = crypto.createHash('md5').update(filePath).digest('hex');
  return path.join(THUMBS_DIR, h + '.jpg');
}

// Full cascade delete for a photo row (conn must already be open)
function deletePhotoRow(conn, photo) {
  // DB cascade
  const faceIds = conn.prepare('SELECT id FROM faces WHERE photo_id=?').all(photo.id).map(f => f.id);
  for (const fid of faceIds) {
    conn.prepare('UPDATE persons SET cover_face_id=NULL WHERE cover_face_id=?').run(fid);
    conn.prepare('DELETE FROM face_persons WHERE face_id=?').run(fid);
  }
  conn.prepare('UPDATE rolls SET cover_photo_id=NULL WHERE cover_photo_id=?').run(photo.id);
  conn.prepare('DELETE FROM photo_embeddings WHERE photo_id=?').run(photo.id);
  conn.prepare('DELETE FROM faces WHERE photo_id=?').run(photo.id);
  conn.prepare('DELETE FROM photo_tags WHERE photo_id=?').run(photo.id);
  conn.prepare('DELETE FROM photos WHERE id=?').run(photo.id);
  // Disk cleanup
  const toDelete = [
    photo.file_path,
    thumbFor(photo.file_path),
    path.join(THUMBS_DIR, 'display', `${photo.id}.jpg`),
    webCachePath(photo.id),
  ];
  for (const f of toDelete) {
    try { if (f && fs.existsSync(f)) fs.unlinkSync(f); } catch {}
  }
}

const VIDEO_EXTS = new Set(['.mp4', '.mov', '.avi', '.mkv', '.m4v', '.webm']);
function isVideoFile(filePath) {
  return VIDEO_EXTS.has(path.extname(filePath).toLowerCase());
}

function streamFile(res, filePath, mimeType, cache = false) {
  if (!fs.existsSync(filePath)) return res.status(404).end();
  const stat = fs.statSync(filePath);
  res.setHeader('Content-Type', mimeType);
  res.setHeader('Content-Length', stat.size);
  if (cache) {
    res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
    res.setHeader('Last-Modified', stat.mtime.toUTCString());
  }
  fs.createReadStream(filePath).pipe(res);
}

function streamMedia(req, res, filePath, mimeType) {
  if (!fs.existsSync(filePath)) return res.status(404).end();
  const total = fs.statSync(filePath).size;
  const range = req.headers.range;
  if (range) {
    const [startStr, endStr] = range.replace(/bytes=/, '').split('-');
    const start = parseInt(startStr, 10);
    const end   = endStr ? parseInt(endStr, 10) : Math.min(start + 1024 * 1024 - 1, total - 1);
    res.writeHead(206, {
      'Content-Range':  `bytes ${start}-${end}/${total}`,
      'Accept-Ranges':  'bytes',
      'Content-Length': end - start + 1,
      'Content-Type':   mimeType,
    });
    fs.createReadStream(filePath, { start, end }).pipe(res);
  } else {
    res.writeHead(200, {
      'Content-Length': total,
      'Content-Type':   mimeType,
      'Accept-Ranges':  'bytes',
    });
    fs.createReadStream(filePath).pipe(res);
  }
}

function mimeFor(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === '.png')  return 'image/png';
  if (ext === '.tif' || ext === '.tiff') return 'image/tiff';
  if (ext === '.mp4' || ext === '.m4v')  return 'video/mp4';
  if (ext === '.mov')  return 'video/quicktime';
  if (ext === '.avi')  return 'video/x-msvideo';
  if (ext === '.mkv')  return 'video/x-matroska';
  if (ext === '.webm') return 'video/webm';
  return 'image/jpeg';
}

// ── images ────────────────────────────────────────────────────────────────────

const VIDEO_THUMB_SVG = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 160 160">
  <rect width="160" height="160" fill="#1a1917"/>
  <circle cx="80" cy="80" r="30" fill="none" stroke="rgba(255,255,255,0.35)" stroke-width="1.5"/>
  <polygon points="71,66 71,94 101,80" fill="rgba(255,255,255,0.7)"/>
</svg>`);

app.get('/thumb/:id', async (req, res) => {
  const conn = db();
  const row = conn.prepare('SELECT file_path FROM photos WHERE id=?').get(req.params.id);
  conn.close();
  if (!row) return res.status(404).end();

  if (isVideoFile(row.file_path)) {
    const tp = thumbFor(row.file_path);
    if (!fs.existsSync(tp)) {
      await new Promise(resolve => {
        execFile(ffmpegPath, [
          '-i', row.file_path,
          '-ss', '00:00:01',
          '-vframes', '1',
          '-vf', 'scale=480:480:force_original_aspect_ratio=decrease',
          '-y', tp,
        ], resolve);
      });
    }
    if (fs.existsSync(tp)) return streamFile(res, tp, 'image/jpeg', true);
    res.setHeader('Content-Type', 'image/svg+xml');
    return res.send(VIDEO_THUMB_SVG);
  }

  const tp = thumbFor(row.file_path);
  if (!fs.existsSync(tp)) {
    try {
      await sharp(row.file_path)
        .resize(480, 480, { fit: 'inside', withoutEnlargement: true })
        .jpeg({ quality: 82 })
        .toFile(tp);
    } catch {
      return streamFile(res, row.file_path, mimeFor(row.file_path));
    }
  }
  streamFile(res, tp, 'image/jpeg', true);
});

app.get('/full/:id', (req, res) => {
  const conn = db();
  const row = conn.prepare('SELECT id, file_path, filename FROM photos WHERE id=?').get(req.params.id);
  conn.close();
  if (!row) return res.status(404).end();
  const mime = mimeFor(row.file_path);
  if (isVideoFile(row.file_path)) {
    const wp = webCachePath(row.id);
    if (fs.existsSync(wp)) return streamMedia(req, res, wp, 'video/mp4');
    // Kick off background web-cache creation so next download is faster
    if (!transcodingJobs.has(row.id)) {
      transcodingJobs.add(row.id);
      const tmpPath = wp + '.tmp.mp4';
      execFile(ffmpegPath, [
        '-i', row.file_path,
        '-c:v', 'libx264', '-crf', '22', '-preset', 'ultrafast',
        '-vf', 'scale=-2:min(ih\\,1080)',
        '-pix_fmt', 'yuv420p',
        '-c:a', 'aac',
        '-movflags', '+faststart',
        '-y', tmpPath,
      ], (err) => {
        transcodingJobs.delete(row.id);
        if (!err) { try { fs.renameSync(tmpPath, wp); } catch {} }
        else { try { fs.unlinkSync(tmpPath); } catch {} }
      });
    }
    return streamMedia(req, res, row.file_path, mime);
  }
  streamFile(res, row.file_path, mime);
});

app.get('/api/photo/:id/web-status', (req, res) => {
  const id = Number(req.params.id);
  const wp = webCachePath(id);
  if (fs.existsSync(wp)) return res.json({ ready: true, transcoding: false });
  if (transcodingJobs.has(id)) return res.json({ ready: false, transcoding: true });

  const conn = db();
  const row = conn.prepare('SELECT file_path FROM photos WHERE id=?').get(id);
  conn.close();
  if (!row || !isVideoFile(row.file_path)) return res.json({ ready: false, transcoding: false });

  transcodingJobs.add(id);
  const tmpPath = wp + '.tmp.mp4';
  execFile(ffmpegPath, [
    '-i', row.file_path,
    '-c:v', 'libx264', '-crf', '22', '-preset', 'ultrafast',
    '-vf', 'scale=-2:min(ih\\,1080)',
    '-pix_fmt', 'yuv420p',
    '-c:a', 'aac',
    '-movflags', '+faststart',
    '-y', tmpPath,
  ], (err) => {
    transcodingJobs.delete(id);
    if (!err) { try { fs.renameSync(tmpPath, wp); } catch {} }
    else { try { fs.unlinkSync(tmpPath); } catch {} }
  });

  res.json({ ready: false, transcoding: true });
});

app.get('/api/roll/:id/download', (req, res) => {
  const conn = db();
  const roll = conn.prepare('SELECT * FROM rolls WHERE id=?').get(req.params.id);
  if (!roll) { conn.close(); return res.status(404).end(); }

  const showHidden = res.locals.showHidden;
  const hf = showHidden ? '' : 'AND hidden=0';
  const photos = conn.prepare(
    `SELECT file_path, filename FROM photos WHERE roll_id=? ${hf} ORDER BY filename`
  ).all(req.params.id);
  conn.close();

  const parts = (roll.rel_path || '').split(/[/\\]/);
  const rollName = (parts[parts.length - 1] || 'album').replace(/[^\w\s.\-]/g, '_');

  res.setHeader('Content-Type', 'application/zip');
  res.setHeader('Content-Disposition', `attachment; filename="${rollName}.zip"`);

  const archive = new ZipArchive({ zlib: { level: 6 } });
  archive.on('error', () => res.end());
  archive.pipe(res);

  for (const photo of photos) {
    if (fs.existsSync(photo.file_path)) {
      archive.file(photo.file_path, { name: photo.filename });
    }
  }

  archive.finalize();
});

// ── pages ─────────────────────────────────────────────────────────────────────

app.get('/', (req, res) => {
  const conn = db();
  const showHidden = res.locals.showHidden;

  const stats = {
    filmPhotos:     conn.prepare("SELECT COUNT(*) as n FROM photos p JOIN rolls r ON p.roll_id=r.id JOIN cameras c ON r.camera_id=c.id WHERE c.name LIKE '35mm prints / %'").get().n,
    filmRolls:      conn.prepare("SELECT COUNT(*) as n FROM rolls r JOIN cameras c ON r.camera_id=c.id WHERE c.name LIKE '35mm prints / %'").get().n,
    digitalPhotos:  conn.prepare("SELECT COUNT(*) as n FROM photos p JOIN rolls r ON p.roll_id=r.id JOIN cameras c ON r.camera_id=c.id WHERE c.name LIKE 'Digital / %'").get().n,
    digitalAlbums:  conn.prepare("SELECT COUNT(*) as n FROM rolls r JOIN cameras c ON r.camera_id=c.id WHERE c.name LIKE 'Digital / %'").get().n,
    totalCameras:   conn.prepare('SELECT COUNT(*) as n FROM cameras').get().n,
    totalFavorites: conn.prepare('SELECT COUNT(*) as n FROM photos WHERE favorite=1').get().n,
    totalHidden:    conn.prepare('SELECT COUNT(*) as n FROM photos WHERE hidden=1').get().n,
  };

  const photosByYear = conn.prepare(`
    SELECT r.year, COUNT(p.id) as count
    FROM photos p JOIN rolls r ON p.roll_id=r.id
    WHERE r.year IS NOT NULL GROUP BY r.year ORDER BY r.year
  `).all();

  const maxYear = photosByYear.reduce((m, r) => Math.max(m, r.count), 1);

  const ph = showHidden ? '' : 'AND p.hidden=0';
  const topCameras = conn.prepare(`
    SELECT c.id, c.name, COUNT(p.id) as count,
           (SELECT COALESCE(r2.cover_photo_id,
              (SELECT p2.id FROM photos p2 WHERE p2.roll_id=r2.id AND p2.hidden=0 LIMIT 1))
            FROM rolls r2 WHERE r2.camera_id=c.id LIMIT 1) as preview_id
    FROM cameras c JOIN rolls r ON r.camera_id=c.id JOIN photos p ON p.roll_id=r.id
    WHERE 1=1 ${ph}
    GROUP BY c.id ORDER BY count DESC LIMIT 10
  `).all();

  const filmStocks = conn.prepare(`
    SELECT film_stock, COUNT(*) as count FROM rolls
    WHERE film_stock IS NOT NULL
    GROUP BY lower(film_stock) ORDER BY count DESC LIMIT 12
  `).all();

  const recentRolls = conn.prepare(`
    SELECT r.id, r.rel_path, r.year, r.date_label, r.film_stock,
           c.name as camera_name, c.id as camera_id,
           COUNT(p.id) as photo_count,
           COALESCE(r.cover_photo_id,
             (SELECT p2.id FROM photos p2 WHERE p2.roll_id=r.id AND p2.hidden=0 LIMIT 1)) as preview_id
    FROM rolls r JOIN cameras c ON r.camera_id=c.id JOIN photos p ON p.roll_id=r.id
    WHERE c.name LIKE '35mm prints / %'
    GROUP BY r.id ORDER BY r.year DESC, r.date_label DESC LIMIT 8
  `).all();

  const recentDigital = conn.prepare(`
    SELECT r.id, r.rel_path, r.year, r.date_label,
           c.name as camera_name, c.id as camera_id,
           COUNT(p.id) as photo_count,
           COALESCE(r.cover_photo_id,
             (SELECT p2.id FROM photos p2 WHERE p2.roll_id=r.id AND p2.hidden=0 LIMIT 1)) as preview_id
    FROM rolls r JOIN cameras c ON r.camera_id=c.id JOIN photos p ON p.roll_id=r.id
    WHERE c.name LIKE 'Digital / %'
    GROUP BY r.id ORDER BY r.year DESC, r.date_label DESC LIMIT 8
  `).all();

  conn.close();
  res.render('index', { page: 'index', stats, photosByYear, maxYear, topCameras, filmStocks, recentRolls, recentDigital });
});

app.get('/cameras', (req, res) => {
  const conn = db();
  const tab = req.query.tab || 'all'; // 'all' | '35mm' | 'digital'
  const cameras = conn.prepare(`
    SELECT c.id, c.name,
           COUNT(DISTINCT r.id) as roll_count, COUNT(p.id) as photo_count,
           (SELECT COALESCE(r2.cover_photo_id,
              (SELECT p2.id FROM photos p2 WHERE p2.roll_id=r2.id AND p2.hidden=0 LIMIT 1))
            FROM rolls r2 WHERE r2.camera_id=c.id LIMIT 1) as preview_id
    FROM cameras c
    LEFT JOIN rolls r ON r.camera_id=c.id
    LEFT JOIN photos p ON p.roll_id=r.id
    GROUP BY c.id ORDER BY c.name
  `).all();
  conn.close();
  res.render('cameras', { page: 'cameras', cameras, tab });
});

app.get('/rolls', (req, res) => {
  const conn = db();
  const showHidden   = res.locals.showHidden;
  const filterYear   = req.query.year   || '';
  const filterCamera = req.query.camera || '';
  const tab          = req.query.tab    || 'all';

  const rolls = conn.prepare(`
    SELECT r.id, r.rel_path, r.year, r.date_label, r.film_stock, r.notes,
           c.id as camera_id, c.name as camera_name,
           COUNT(p.id) as photo_count,
           COALESCE(r.cover_photo_id,
             (SELECT p2.id FROM photos p2 WHERE p2.roll_id=r.id AND p2.hidden=0 LIMIT 1)) as preview_id
    FROM rolls r
    JOIN cameras c ON r.camera_id=c.id
    LEFT JOIN photos p ON p.roll_id=r.id
    WHERE c.name LIKE '35mm prints / %' AND (r.hidden=0 OR ? = 1)
    GROUP BY r.id
    ORDER BY r.year DESC, r.date_label DESC, c.name
  `).all(showHidden ? 1 : 0);

  const years   = [...new Set(rolls.map(r => r.year).filter(Boolean))].sort((a, b) => b - a);
  const cameras = [...new Map(rolls.map(r => [r.camera_id, r.camera_name])).entries()]
                    .map(([id, name]) => ({ id, name: name.replace(/^35mm prints \/ /, '') }))
                    .sort((a, b) => a.name.localeCompare(b.name));

  // Distinct known film stocks for the quick-set dropdown
  const filmStocks = conn.prepare(
    `SELECT DISTINCT film_stock FROM rolls WHERE film_stock IS NOT NULL AND film_stock != '' ORDER BY film_stock`
  ).all().map(r => r.film_stock);

  conn.close();
  res.render('rolls', { page: 'rolls', rolls, years, cameras, filterYear, filterCamera, tab, filmStocks });
});

app.get('/digital', (req, res) => {
  const conn = db();
  const showHidden   = res.locals.showHidden;
  const filterYear   = req.query.year   || '';
  const filterCamera = req.query.camera || '';

  const rolls = conn.prepare(`
    SELECT r.id, r.rel_path, r.year, r.date_label, r.film_stock, r.notes,
           c.id as camera_id, c.name as camera_name,
           COUNT(p.id) as photo_count,
           COALESCE(r.cover_photo_id,
             (SELECT p2.id FROM photos p2 WHERE p2.roll_id=r.id AND p2.hidden=0 LIMIT 1)) as preview_id
    FROM rolls r
    JOIN cameras c ON r.camera_id=c.id
    LEFT JOIN photos p ON p.roll_id=r.id
    WHERE c.name LIKE 'Digital / %' AND (r.hidden=0 OR ? = 1)
    GROUP BY r.id
    ORDER BY r.year DESC, r.date_label DESC, c.name
  `).all(showHidden ? 1 : 0);

  const years   = [...new Set(rolls.map(r => r.year).filter(Boolean))].sort((a, b) => b - a);
  const cameras = [...new Map(rolls.map(r => [r.camera_id, r.camera_name])).entries()]
                    .map(([id, name]) => ({ id, name: name.replace(/^Digital \/ /, '') }))
                    .sort((a, b) => a.name.localeCompare(b.name));

  conn.close();
  res.render('digital', { page: 'digital', rolls, years, cameras, filterYear, filterCamera });
});

app.get('/videos', (req, res) => {
  const conn = db();
  const showHidden   = res.locals.showHidden;
  const filterYear   = req.query.year   || '';
  const filterCamera = req.query.camera || '';

  const rolls = conn.prepare(`
    SELECT r.id, r.rel_path, r.year, r.date_label, r.notes,
           c.id as camera_id, c.name as camera_name,
           COUNT(p.id) as video_count,
           COALESCE(r.cover_photo_id,
             (SELECT p2.id FROM photos p2 WHERE p2.roll_id=r.id LIMIT 1)) as preview_id
    FROM rolls r
    JOIN cameras c ON r.camera_id=c.id
    LEFT JOIN photos p ON p.roll_id=r.id
    WHERE c.name LIKE 'Video / %' AND (r.hidden=0 OR ? = 1)
    GROUP BY r.id
    ORDER BY r.year DESC, r.date_label DESC, c.name
  `).all(showHidden ? 1 : 0);

  const years   = [...new Set(rolls.map(r => r.year).filter(Boolean))].sort((a, b) => b - a);
  const cameras = [...new Map(rolls.map(r => [r.camera_id, r.camera_name])).entries()]
                    .map(([id, name]) => ({ id, name: name.replace(/^Video \/ /, '') }))
                    .sort((a, b) => a.name.localeCompare(b.name));

  conn.close();
  res.render('videos', { page: 'videos', rolls, years, cameras, filterYear, filterCamera });
});

app.get('/camera/:id', (req, res) => {
  const conn = db();
  const showHidden = res.locals.showHidden;
  const camera = conn.prepare('SELECT * FROM cameras WHERE id=?').get(req.params.id);
  if (!camera) { conn.close(); return res.status(404).end(); }

  const rolls = conn.prepare(`
    SELECT r.id, r.rel_path, r.year, r.date_label, r.film_stock, r.notes,
           COUNT(p.id) as photo_count,
           COALESCE(r.cover_photo_id,
             (SELECT p2.id FROM photos p2 WHERE p2.roll_id=r.id AND p2.hidden=0 LIMIT 1)) as preview_id
    FROM rolls r LEFT JOIN photos p ON p.roll_id=r.id
    WHERE r.camera_id=? AND (r.hidden=0 OR ? = 1)
    GROUP BY r.id ORDER BY r.year DESC, r.date_label
  `).all(req.params.id, showHidden ? 1 : 0);

  const filterYear = req.query.year || '';
  const years = [...new Set(rolls.map(r => r.year).filter(Boolean))].sort((a, b) => b - a);
  conn.close();
  res.render('camera', { page: 'camera', camera, rolls, years, filterYear });
});

app.get('/roll/:id', (req, res) => {
  const conn = db();
  const roll = conn.prepare(`
    SELECT r.*, c.name as camera_name, c.id as camera_id,
           COALESCE(r.cover_photo_id,
             (SELECT p2.id FROM photos p2 WHERE p2.roll_id=r.id AND p2.hidden=0 LIMIT 1)) as effective_cover_id
    FROM rolls r JOIN cameras c ON r.camera_id=c.id WHERE r.id=?
  `).get(req.params.id);
  if (!roll) { conn.close(); return res.status(404).end(); }

  const showHidden = res.locals.showHidden;
  const hf = showHidden ? '' : 'AND p.hidden=0';
  const photos = conn.prepare(`
    SELECT p.id, p.filename, p.notes, p.favorite, p.hidden,
           GROUP_CONCAT(t.name, ',') as tag_names
    FROM photos p
    LEFT JOIN photo_tags pt ON pt.photo_id=p.id
    LEFT JOIN tags t ON t.id=pt.tag_id
    WHERE p.roll_id=? ${hf} GROUP BY p.id ORDER BY p.filename
  `).all(req.params.id);

  const hiddenCount = showHidden ? 0 :
    conn.prepare('SELECT COUNT(*) as n FROM photos WHERE roll_id=? AND hidden=1').get(req.params.id).n;

  conn.close();
  res.render('roll', { page: 'roll', roll, photos, hiddenCount, showHidden });
});

app.get('/photo/:id', async (req, res) => {
  const conn = db();
  const photo = conn.prepare(`
    SELECT p.*, r.id as roll_id, r.rel_path, r.date_label, r.film_stock, r.year,
           r.cover_photo_id,
           c.name as camera_name, c.id as camera_id
    FROM photos p JOIN rolls r ON p.roll_id=r.id JOIN cameras c ON r.camera_id=c.id
    WHERE p.id=?
  `).get(req.params.id);
  if (!photo) { conn.close(); return res.status(404).end(); }

  const siblings = conn.prepare('SELECT id FROM photos WHERE roll_id=? ORDER BY filename')
    .all(photo.roll_id).map(r => r.id);
  const idx = siblings.indexOf(Number(req.params.id));

  const tags = conn.prepare(`
    SELECT t.name FROM tags t JOIN photo_tags pt ON pt.tag_id=t.id WHERE pt.photo_id=?
  `).all(photo.id).map(t => t.name);

  conn.close();

  // Fetch people from Immich — cache immich_id to avoid repeated searches
  let peopleInPhoto = [];
  try {
    let immichId = photo.immich_id;
    if (!immichId) {
      const immichPath = photo.file_path
        .replace('C:\\Users\\aleez\\Desktop\\Photos\\Aleezas Photo Database\\', '/photos/')
        .replace(/\\/g, '/');
      const filename = immichPath.split('/').pop();
      const sr = await immichFetch('/api/search/metadata', {
        method: 'POST',
        body: JSON.stringify({ deviceAssetId: filename, size: 20 }),
      });
      if (sr.ok) {
        const sd = await sr.json();
        const asset = (sd?.assets?.items || []).find(a => a.originalPath === immichPath);
        if (asset?.id) {
          immichId = asset.id;
          const connU = db();
          connU.prepare('UPDATE photos SET immich_id=? WHERE id=?').run(immichId, photo.id);
          connU.close();
        }
      }
    }
    if (immichId) {
      const ar = await immichFetch(`/api/assets/${immichId}`);
      if (ar.ok) {
        const asset = await ar.json();
        peopleInPhoto = (asset.people || [])
          .filter(p => !p.isHidden)
          .map(p => ({ id: p.id, name: p.name || null, face_id: p.id, immich: true }));
      }
    }
  } catch {}

  res.render('photo', {
    page: 'photo', photo, tags, peopleInPhoto,
    isVideo: isVideoFile(photo.file_path),
    prevId: idx > 0 ? siblings[idx - 1] : null,
    nextId: idx < siblings.length - 1 ? siblings[idx + 1] : null,
    photoNum: idx + 1, total: siblings.length,
  });
});

app.get('/share/:token/photo/:photoId', (req, res) => {
  const conn = db();
  const roll = conn.prepare('SELECT * FROM rolls WHERE share_token=?').get(req.params.token);
  if (!roll) { conn.close(); return res.status(404).end(); }

  const photo = conn.prepare('SELECT * FROM photos WHERE id=? AND roll_id=? AND hidden=0').get(req.params.photoId, roll.id);
  if (!photo) { conn.close(); return res.status(404).end(); }

  const siblings = conn.prepare('SELECT id FROM photos WHERE roll_id=? AND hidden=0 ORDER BY filename').all(roll.id).map(r => r.id);
  const idx = siblings.indexOf(Number(req.params.photoId));

  conn.close();
  res.render('share-photo', {
    roll, photo, token: req.params.token,
    isVideo: isVideoFile(photo.file_path),
    prevId: idx > 0 ? siblings[idx - 1] : null,
    nextId: idx < siblings.length - 1 ? siblings[idx + 1] : null,
    photoNum: idx + 1, total: siblings.length,
  });
});

app.get('/share/:token', (req, res) => {
  const conn = db();
  const roll = conn.prepare(`
    SELECT r.*, c.name as camera_name, c.id as camera_id
    FROM rolls r JOIN cameras c ON r.camera_id=c.id
    WHERE r.share_token=?
  `).get(req.params.token);

  if (!roll) { conn.close(); return res.status(404).render('share-404'); }

  const photos = conn.prepare(
    'SELECT * FROM photos WHERE roll_id=? AND hidden=0 ORDER BY filename'
  ).all(roll.id).map(p => {
    let file_size = 0;
    try { file_size = fs.statSync(p.file_path).size; } catch {}
    return { ...p, file_size };
  });

  conn.close();
  res.render('share', { roll, photos, token: req.params.token });
});

app.get('/share/:token/thumb/:photoId', async (req, res) => {
  const conn = db();
  const roll = conn.prepare('SELECT id FROM rolls WHERE share_token=?').get(req.params.token);
  if (!roll) { conn.close(); return res.status(404).end(); }
  const row = conn.prepare('SELECT file_path FROM photos WHERE id=? AND roll_id=? AND hidden=0').get(req.params.photoId, roll.id);
  conn.close();
  if (!row) return res.status(404).end();

  if (isVideoFile(row.file_path)) {
    const tp = thumbFor(row.file_path);
    if (!fs.existsSync(tp)) {
      await new Promise(resolve => {
        execFile(ffmpegPath, ['-i', row.file_path, '-ss', '00:00:01', '-vframes', '1', '-vf', 'scale=480:480:force_original_aspect_ratio=decrease', '-y', tp], resolve);
      });
    }
    if (fs.existsSync(tp)) return streamFile(res, tp, 'image/jpeg', true);
    res.setHeader('Content-Type', 'image/svg+xml');
    return res.send(VIDEO_THUMB_SVG);
  }

  const tp = thumbFor(row.file_path);
  if (!fs.existsSync(tp)) {
    try {
      await sharp(row.file_path).resize(480, 480, { fit: 'inside', withoutEnlargement: true }).jpeg({ quality: 82 }).toFile(tp);
    } catch {
      return streamFile(res, row.file_path, mimeFor(row.file_path));
    }
  }
  streamFile(res, tp, 'image/jpeg');
});

app.get('/share/:token/display/:photoId', async (req, res) => {
  const conn = db();
  const roll = conn.prepare('SELECT id FROM rolls WHERE share_token=?').get(req.params.token);
  if (!roll) { conn.close(); return res.status(404).end(); }
  const row = conn.prepare('SELECT id, file_path FROM photos WHERE id=? AND roll_id=? AND hidden=0').get(req.params.photoId, roll.id);
  conn.close();
  if (!row) return res.status(404).end();

  if (isVideoFile(row.file_path)) {
    const wp = webCachePath(row.id);
    if (fs.existsSync(wp)) return streamMedia(req, res, wp, 'video/mp4');
    return streamMedia(req, res, row.file_path, mimeFor(row.file_path));
  }

  const displayPath = path.join(THUMBS_DIR, 'display', `${row.id}.jpg`);
  fs.mkdirSync(path.dirname(displayPath), { recursive: true });
  if (!fs.existsSync(displayPath)) {
    try {
      await sharp(row.file_path)
        .resize(1920, 1920, { fit: 'inside', withoutEnlargement: true })
        .withMetadata()
        .jpeg({ quality: 88 })
        .toFile(displayPath);
    } catch {
      return streamFile(res, row.file_path, mimeFor(row.file_path));
    }
  }
  streamFile(res, displayPath, 'image/jpeg', true);
});

app.get('/share/:token/full/:photoId', (req, res) => {
  const conn = db();
  const roll = conn.prepare('SELECT id FROM rolls WHERE share_token=?').get(req.params.token);
  if (!roll) { conn.close(); return res.status(404).end(); }
  const row = conn.prepare('SELECT id, file_path, filename FROM photos WHERE id=? AND roll_id=? AND hidden=0').get(req.params.photoId, roll.id);
  conn.close();
  if (!row) return res.status(404).end();
  const mime = mimeFor(row.file_path);
  if (isVideoFile(row.file_path)) {
    const wp = webCachePath(row.id);
    if (fs.existsSync(wp)) return streamMedia(req, res, wp, 'video/mp4');
    return streamMedia(req, res, row.file_path, mime);
  }
  streamFile(res, row.file_path, mime);
});

app.get('/share/:token/web-status/:photoId', (req, res) => {
  const conn = db();
  const roll = conn.prepare('SELECT id FROM rolls WHERE share_token=?').get(req.params.token);
  if (!roll) { conn.close(); return res.status(404).end(); }
  const row = conn.prepare('SELECT file_path FROM photos WHERE id=? AND roll_id=? AND hidden=0').get(req.params.photoId, roll.id);
  conn.close();
  if (!row) return res.status(404).end();

  const id = Number(req.params.photoId);
  const wp = webCachePath(id);
  if (fs.existsSync(wp)) return res.json({ ready: true, transcoding: false });
  if (transcodingJobs.has(id)) return res.json({ ready: false, transcoding: true });

  transcodingJobs.add(id);
  const tmpPath = wp + '.tmp.mp4';
  execFile(ffmpegPath, [
    '-i', row.file_path,
    '-c:v', 'libx264', '-crf', '22', '-preset', 'ultrafast',
    '-vf', 'scale=-2:min(ih\\,1080)',
    '-pix_fmt', 'yuv420p',
    '-c:a', 'aac',
    '-movflags', '+faststart',
    '-y', tmpPath,
  ], (err) => {
    transcodingJobs.delete(id);
    if (!err) { try { fs.renameSync(tmpPath, wp); } catch {} }
    else { try { fs.unlinkSync(tmpPath); } catch {} }
  });

  res.json({ ready: false, transcoding: true });
});

// Single photo original download (share-scoped)
app.get('/share/:token/original/:photoId', (req, res) => {
  const conn = db();
  const roll = conn.prepare('SELECT id FROM rolls WHERE share_token=?').get(req.params.token);
  if (!roll) { conn.close(); return res.status(404).end(); }
  const row = conn.prepare('SELECT file_path, filename FROM photos WHERE id=? AND roll_id=? AND hidden=0').get(req.params.photoId, roll.id);
  conn.close();
  if (!row) return res.status(404).end();
  res.setHeader('Content-Disposition', `attachment; filename="${row.filename}"`);
  streamFile(res, row.file_path, mimeFor(row.file_path));
});

app.get('/share/:token/download', (req, res) => {
  const original = req.query.type === 'original';
  const conn = db();
  const roll = conn.prepare('SELECT * FROM rolls WHERE share_token=?').get(req.params.token);
  if (!roll) { conn.close(); return res.status(404).end(); }

  const photos = conn.prepare(
    'SELECT id, file_path, filename FROM photos WHERE roll_id=? AND hidden=0 ORDER BY filename'
  ).all(roll.id);
  conn.close();

  const parts = (roll.rel_path || '').split(/[/\\]/);
  const rollName = (parts[parts.length - 1] || 'album').replace(/[^\w\s.\-]/g, '_');
  const suffix = original ? '-original' : '-compressed';

  res.setHeader('Content-Type', 'application/zip');
  res.setHeader('Content-Disposition', `attachment; filename="${rollName}${suffix}.zip"`);

  const archive = new ZipArchive({ zlib: { level: 0 } });
  archive.on('error', () => res.end());
  archive.pipe(res);

  for (const photo of photos) {
    if (original) {
      if (fs.existsSync(photo.file_path)) archive.file(photo.file_path, { name: photo.filename });
    } else if (isVideoFile(photo.file_path)) {
      const wp = webCachePath(photo.id);
      const src = fs.existsSync(wp) ? wp : photo.file_path;
      const name = fs.existsSync(wp) ? photo.filename.replace(/\.[^.]+$/, '.mp4') : photo.filename;
      if (fs.existsSync(src)) archive.file(src, { name });
    } else {
      const dp = path.join(THUMBS_DIR, 'display', `${photo.id}.jpg`);
      const src = fs.existsSync(dp) ? dp : photo.file_path;
      const name = fs.existsSync(dp) ? photo.filename.replace(/\.[^.]+$/, '.jpg') : photo.filename;
      if (fs.existsSync(src)) archive.file(src, { name });
    }
  }

  archive.finalize();
});

app.get('/search', (req, res) => {
  const { q = '', camera = '', film = '', year = '', tag = '', favs = '', page: pageStr = '1' } = req.query;
  const PAGE_SIZE = 48;
  const page = Math.max(1, parseInt(pageStr) || 1);
  const offset = (page - 1) * PAGE_SIZE;
  const showHidden = res.locals.showHidden;
  const conn = db();

  let whereSql = `
    FROM photos p JOIN rolls r ON p.roll_id=r.id JOIN cameras c ON r.camera_id=c.id
    LEFT JOIN photo_tags pt ON pt.photo_id=p.id LEFT JOIN tags t ON t.id=pt.tag_id
    WHERE 1=1
  `;
  const params = [];
  if (!showHidden) { whereSql += ' AND p.hidden=0'; }
  if (q)      { whereSql += ' AND (p.notes LIKE ? OR r.film_stock LIKE ? OR r.date_label LIKE ? OR c.name LIKE ?)'; params.push(...Array(4).fill(`%${q}%`)); }
  if (camera) { whereSql += ' AND c.id=?'; params.push(camera); }
  if (film)   { whereSql += ' AND lower(r.film_stock) LIKE ?'; params.push(`%${film.toLowerCase()}%`); }
  if (year)   { whereSql += ' AND r.year=?'; params.push(year); }
  if (tag)    { whereSql += ' AND t.name=?'; params.push(tag); }
  if (favs)   { whereSql += ' AND p.favorite=1'; }

  const totalCount = conn.prepare(`SELECT COUNT(DISTINCT p.id) as n ${whereSql}`).get(...params).n;
  const sql = `SELECT p.id, p.filename, p.notes, p.favorite, p.hidden,
    r.id as roll_id, r.rel_path, r.date_label, r.film_stock, r.year,
    c.id as camera_id, c.name as camera_name,
    GROUP_CONCAT(t.name, ',') as tag_names
    ${whereSql} GROUP BY p.id ORDER BY r.year DESC, r.date_label, p.filename
    LIMIT ${PAGE_SIZE} OFFSET ${offset}`;

  const photos = conn.prepare(sql).all(...params);
  const allCameras = conn.prepare('SELECT * FROM cameras ORDER BY name').all();
  const allTags    = conn.prepare('SELECT * FROM tags ORDER BY name').all();
  const allYears   = conn.prepare('SELECT DISTINCT year FROM rolls WHERE year IS NOT NULL ORDER BY year DESC').all();
  const allStocks  = conn.prepare('SELECT DISTINCT film_stock FROM rolls WHERE film_stock IS NOT NULL ORDER BY film_stock').all();
  conn.close();

  res.render('search', { page: 'search', photos, allCameras, allTags, allYears, allStocks, q, camera, film, year, tag, favs, showHidden, totalCount, currentPage: page, pageSize: PAGE_SIZE });
});

// ── API ───────────────────────────────────────────────────────────────────────

app.post('/api/photo/:id/favorite', (req, res) => {
  const conn = db();
  const row = conn.prepare('SELECT favorite FROM photos WHERE id=?').get(req.params.id);
  if (!row) { conn.close(); return res.status(404).end(); }
  const val = row.favorite ? 0 : 1;
  conn.prepare('UPDATE photos SET favorite=? WHERE id=?').run(val, req.params.id);
  conn.close();
  res.json({ favorite: !!val });
});

app.post('/api/photo/:id/notes', (req, res) => {
  const conn = db();
  conn.prepare('UPDATE photos SET notes=? WHERE id=?').run(req.body.notes || '', req.params.id);
  conn.close();
  res.json({ ok: true });
});

app.post('/api/photo/:id/tags', (req, res) => {
  const conn = db();
  const names = (req.body.tags || []).map(t => t.trim().toLowerCase()).filter(Boolean);
  conn.prepare('DELETE FROM photo_tags WHERE photo_id=?').run(req.params.id);
  for (const name of names) {
    conn.prepare('INSERT OR IGNORE INTO tags (name) VALUES (?)').run(name);
    const tag = conn.prepare('SELECT id FROM tags WHERE name=?').get(name);
    conn.prepare('INSERT OR IGNORE INTO photo_tags (photo_id, tag_id) VALUES (?,?)').run(req.params.id, tag.id);
  }
  // hijabi tag auto-hides the photo
  if (names.includes('hijabi')) {
    conn.prepare('UPDATE photos SET hidden=1 WHERE id=?').run(req.params.id);
  }
  conn.close();
  res.json({ ok: true });
});

app.post('/api/photo/:id/hidden', (req, res) => {
  const conn = db();
  const row = conn.prepare('SELECT hidden FROM photos WHERE id=?').get(req.params.id);
  if (!row) { conn.close(); return res.status(404).end(); }
  const val = row.hidden ? 0 : 1;
  conn.prepare('UPDATE photos SET hidden=? WHERE id=?').run(val, req.params.id);
  conn.close();
  res.json({ hidden: !!val });
});

app.post('/api/photo/:id/rotate', async (req, res) => {
  const { degrees } = req.body;
  if (![90, -90, 180].includes(degrees)) return res.status(400).json({ error: 'Invalid degrees' });
  const conn = db();
  const row = conn.prepare('SELECT file_path FROM photos WHERE id=?').get(req.params.id);
  conn.close();
  if (!row) return res.status(404).end();
  if (isVideoFile(row.file_path)) return res.status(400).json({ error: 'Cannot rotate video' });

  const tmpPath = row.file_path + '.rot.tmp';
  try {
    await sharp(row.file_path)
      .rotate(degrees)
      .withMetadata()
      .toFile(tmpPath);
    fs.renameSync(tmpPath, row.file_path);
  } catch (err) {
    try { fs.unlinkSync(tmpPath); } catch {}
    return res.status(500).json({ error: err.message });
  }

  const id = Number(req.params.id);
  const tp = thumbFor(row.file_path);
  const dp = path.join(THUMBS_DIR, 'display', `${id}.jpg`);
  try { if (fs.existsSync(tp)) fs.unlinkSync(tp); } catch {}
  try { if (fs.existsSync(dp)) fs.unlinkSync(dp); } catch {}

  res.json({ ok: true });
});

app.delete('/api/photo/:id/web-cache', (req, res) => {
  const wc = webCachePath(Number(req.params.id));
  try { if (fs.existsSync(wc)) fs.unlinkSync(wc); } catch {}
  res.json({ ok: true });
});

app.post('/api/photo/:id/open-folder', (req, res) => {
  const conn = db();
  const row = conn.prepare('SELECT file_path FROM photos WHERE id=?').get(req.params.id);
  conn.close();
  if (!row) return res.status(404).json({ error: 'Not found' });
  const { exec } = require('child_process');
  exec(`explorer /select,"${row.file_path}"`, () => {});
  res.json({ ok: true });
});

app.get('/api/photo/:id/compress-progress', (req, res) => {
  const p = compressProgress.get(Number(req.params.id));
  res.json(p || null);
});

app.post('/api/photo/:id/compress', async (req, res) => {
  const conn = db();
  const row = conn.prepare('SELECT * FROM photos WHERE id=?').get(req.params.id);
  conn.close();
  if (!row) return res.status(404).end();
  if (!isVideoFile(row.file_path)) return res.status(400).json({ error: 'Not a video' });

  const newPath = row.file_path.replace(/\.[^.]+$/, '.mp4');
  const tmpPath = newPath + '.tmp.mp4';

  const totalSecs = await getDuration(row.file_path);
  try {
    await spawnFfmpeg([
      '-i', row.file_path,
      '-c:v', 'libx264', '-crf', '20', '-preset', 'medium',
      '-pix_fmt', 'yuv420p',
      '-c:a', 'aac',
      '-movflags', '+faststart',
      '-y', tmpPath,
    ], Number(req.params.id), totalSecs);
  } catch (err) {
    try { fs.unlinkSync(tmpPath); } catch {}
    return res.status(500).json({ error: err.message });
  }

  try {
    if (row.file_path !== newPath) fs.unlinkSync(row.file_path);
    else fs.unlinkSync(row.file_path);
    fs.renameSync(tmpPath, newPath);
  } catch (err) {
    return res.status(500).json({ error: 'Could not replace file' });
  }

  const conn2 = db();
  conn2.prepare('UPDATE photos SET file_path=?, filename=? WHERE id=?')
       .run(newPath, path.basename(newPath), row.id);
  conn2.close();

  const oldThumb = thumbFor(row.file_path);
  try { if (fs.existsSync(oldThumb)) fs.unlinkSync(oldThumb); } catch {}
  const newThumb = thumbFor(newPath);
  try { if (fs.existsSync(newThumb)) fs.unlinkSync(newThumb); } catch {}
  const wc = webCachePath(Number(req.params.id));
  try { if (fs.existsSync(wc)) fs.unlinkSync(wc); } catch {}

  res.json({ ok: true });
});

app.post('/api/photo/:id/convert', async (req, res) => {
  const conn = db();
  const row = conn.prepare('SELECT * FROM photos WHERE id=?').get(req.params.id);
  conn.close();
  if (!row) return res.status(404).end();
  if (!isVideoFile(row.file_path)) return res.status(400).json({ error: 'Not a video file' });

  const ext = path.extname(row.file_path).toLowerCase();
  if (ext === '.mp4') return res.json({ ok: true, already: true });

  const mp4Path = row.file_path.replace(/\.[^.]+$/, '.mp4');
  const mp4Name = path.basename(mp4Path);

  try {
    await new Promise((resolve, reject) => {
      execFile(ffmpegPath, [
        '-i', row.file_path,
        '-c:v', 'libx264',
        '-c:a', 'aac',
        '-movflags', '+faststart',
        '-y', mp4Path,
      ], (err) => err ? reject(err) : resolve());
    });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }

  const conn2 = db();
  conn2.prepare('UPDATE photos SET file_path=?, filename=? WHERE id=?').run(mp4Path, mp4Name, row.id);
  conn2.close();

  const oldThumb = thumbFor(row.file_path);
  try { if (fs.existsSync(oldThumb)) fs.unlinkSync(oldThumb); } catch {}

  res.json({ ok: true });
});

app.delete('/api/photo/:id', (req, res) => {
  const conn = db();
  const row = conn.prepare('SELECT * FROM photos WHERE id=?').get(req.params.id);
  if (!row) { conn.close(); return res.status(404).end(); }

  deletePhotoRow(conn, row);
  conn.close();
  res.json({ ok: true, rollId: row.roll_id });
});

app.get('/shares', (req, res) => {
  const conn = db();
  const shares = conn.prepare(`
    SELECT r.id, r.rel_path, r.year, r.date_label, r.film_stock, r.share_token,
           c.name as camera_name, COUNT(p.id) as photo_count
    FROM rolls r
    JOIN cameras c ON r.camera_id = c.id
    LEFT JOIN photos p ON p.roll_id = r.id AND p.hidden = 0
    WHERE r.share_token IS NOT NULL
    GROUP BY r.id
    ORDER BY r.year DESC, r.date_label DESC
  `).all();
  conn.close();
  const siteUrl = process.env.SITE_URL || `${req.protocol}://${req.get('host')}`;
  res.render('shares', { page: 'shares', shares, siteUrl });
});

app.post('/api/roll/:id/share', (req, res) => {
  const conn = db();
  const roll = conn.prepare('SELECT id, share_token FROM rolls WHERE id=?').get(req.params.id);
  if (!roll) { conn.close(); return res.status(404).end(); }
  let token = roll.share_token;
  if (!token) {
    token = crypto.randomBytes(20).toString('hex');
    conn.prepare('UPDATE rolls SET share_token=? WHERE id=?').run(token, roll.id);
  }
  conn.close();
  res.json({ token, path: `/share/${token}` });
});

app.delete('/api/roll/:id/share', (req, res) => {
  const conn = db();
  conn.prepare('UPDATE rolls SET share_token=NULL WHERE id=?').run(req.params.id);
  conn.close();
  res.json({ ok: true });
});

app.post('/api/roll/:id/hidden', (req, res) => {
  const conn = db();
  const row = conn.prepare('SELECT hidden FROM rolls WHERE id=?').get(req.params.id);
  if (!row) { conn.close(); return res.status(404).end(); }
  const val = row.hidden ? 0 : 1;
  conn.prepare('UPDATE rolls SET hidden=? WHERE id=?').run(val, req.params.id);
  conn.close();
  res.json({ hidden: !!val });
});

app.post('/api/roll/:id/notes', (req, res) => {
  const conn = db();
  conn.prepare('UPDATE rolls SET notes=? WHERE id=?').run(req.body.notes || '', req.params.id);
  conn.close();
  res.json({ ok: true });
});

app.post('/api/roll/:id/film_stock', (req, res) => {
  const conn = db();
  conn.prepare('UPDATE rolls SET film_stock=? WHERE id=?').run(req.body.film_stock || '', req.params.id);
  conn.close();
  res.json({ ok: true });
});

app.post('/api/film-stocks/merge', (req, res) => {
  const { from, to } = req.body;
  if (!from || !to) return res.status(400).json({ ok: false, error: 'from and to required' });
  const conn = db();
  const result = conn.prepare('UPDATE rolls SET film_stock=? WHERE film_stock=?').run(to, from);
  conn.close();
  res.json({ ok: true, count: result.changes });
});

app.post('/api/photos/bulk-action', (req, res) => {
  const { ids, action } = req.body;
  if (!Array.isArray(ids) || !ids.length) return res.json({ ok: true, count: 0 });

  const conn = db();

  if (action === 'delete') {
    const rows = ids.map(id => conn.prepare('SELECT * FROM photos WHERE id=?').get(id)).filter(Boolean);
    conn.transaction(() => {
      for (const row of rows) {
        deletePhotoRow(conn, row);
      }
    })();
    conn.close();
    return res.json({ ok: true, count: rows.length });
  }

  const stmts = {
    hide:       conn.prepare('UPDATE photos SET hidden=1 WHERE id=?'),
    unhide:     conn.prepare('UPDATE photos SET hidden=0 WHERE id=?'),
    favorite:   conn.prepare('UPDATE photos SET favorite=1 WHERE id=?'),
    unfavorite: conn.prepare('UPDATE photos SET favorite=0 WHERE id=?'),
  };
  if (!stmts[action]) { conn.close(); return res.status(400).json({ error: 'Invalid action' }); }

  conn.transaction(() => ids.forEach(id => stmts[action].run(id)))();
  conn.close();
  res.json({ ok: true, count: ids.length });
});

app.post('/api/rolls/bulk-action', (req, res) => {
  const { ids, action } = req.body;
  if (!Array.isArray(ids) || !ids.length) return res.json({ ok: true });
  const conn = db();

  if (action === 'hide' || action === 'unhide') {
    const val = action === 'hide' ? 1 : 0;
    conn.transaction(() => {
      for (const id of ids) {
        conn.prepare('UPDATE photos SET hidden=? WHERE roll_id=?').run(val, id);
      }
    })();
    conn.close();
    return res.json({ ok: true });
  }

  if (action === 'delete') {
    conn.transaction(() => {
      for (const id of ids) {
        const photos = conn.prepare('SELECT * FROM photos WHERE roll_id=?').all(id);
        for (const photo of photos) {
          deletePhotoRow(conn, photo);
        }
        conn.prepare('DELETE FROM rolls WHERE id=?').run(id);
      }
    })();
    conn.close();
    return res.json({ ok: true });
  }

  conn.close();
  res.status(400).json({ error: 'Invalid action' });
});

app.delete('/api/roll/:id', (req, res) => {
  const conn = db();
  const roll = conn.prepare('SELECT * FROM rolls WHERE id=?').get(req.params.id);
  if (!roll) { conn.close(); return res.status(404).end(); }

  const photos = conn.prepare('SELECT * FROM photos WHERE roll_id=?').all(roll.id);
  conn.transaction(() => {
    for (const photo of photos) {
      deletePhotoRow(conn, photo);
    }
    conn.prepare('DELETE FROM rolls WHERE id=?').run(roll.id);
  })();
  conn.close();
  res.json({ ok: true, cameraId: roll.camera_id });
});

app.post('/api/roll/:id/cover', (req, res) => {
  const photoId = req.body.photo_id || null;
  const conn = db();
  conn.prepare('UPDATE rolls SET cover_photo_id=? WHERE id=?').run(photoId, req.params.id);
  conn.close();
  res.json({ ok: true });
});

// Open in Windows Explorer (highlights the file)
app.get('/open-folder/:id', (req, res) => {
  const conn = db();
  const row = conn.prepare('SELECT file_path FROM photos WHERE id=?').get(req.params.id);
  conn.close();
  if (!row) return res.status(404).json({ error: 'Not found' });
  exec(`explorer.exe /select,"${row.file_path}"`);
  res.json({ ok: true });
});

// Toggle the show-hidden cookie
app.post('/api/toggle-show-hidden', (req, res) => {
  const newVal = !res.locals.showHidden;
  res.setHeader('Set-Cookie', `show_hidden=${newVal ? '1' : '0'}; Path=/; SameSite=Lax`);
  res.json({ showHidden: newVal });
});

// ── roll/album search ─────────────────────────────────────────────────────────

app.get('/api/search/rolls', (req, res) => {
  const { q = '', camera = '', year = '' } = req.query;
  const showHidden = res.locals.showHidden;
  const conn = db();

  const params = [];
  let where = 'WHERE 1=1';
  if (q) {
    where += ' AND (r.rel_path LIKE ? OR r.film_stock LIKE ? OR r.date_label LIKE ? OR c.name LIKE ? OR r.notes LIKE ?)';
    params.push(...Array(5).fill(`%${q}%`));
  }
  if (camera) { where += ' AND c.id=?'; params.push(camera); }
  if (year)   { where += ' AND r.year=?'; params.push(year); }

  const hf  = showHidden ? '' : 'AND p.hidden=0';
  const hf2 = showHidden ? '' : 'AND p2.hidden=0';

  const rolls = conn.prepare(`
    SELECT r.id, r.rel_path, r.year, r.date_label, r.film_stock, r.notes,
           c.id as camera_id, c.name as camera_name,
           COUNT(p.id) as photo_count,
           COALESCE(r.cover_photo_id,
             (SELECT p2.id FROM photos p2 WHERE p2.roll_id=r.id ${hf2} LIMIT 1)) as preview_id
    FROM rolls r
    JOIN cameras c ON r.camera_id=c.id
    LEFT JOIN photos p ON p.roll_id=r.id ${hf}
    ${where}
    GROUP BY r.id
    ORDER BY r.year DESC, r.date_label DESC
    LIMIT 60
  `).all(...params);

  conn.close();
  res.json(rolls);
});

// ── visual search (Immich smart search) ──────────────────────────────────────

app.post('/api/visual-search', async (req, res) => {
  const query = (req.body.query || '').trim();
  if (!query) return res.json([]);

  const page = parseInt(req.body.page) || 1;
  try {
    const r = await immichFetch('/api/search/smart', {
      method: 'POST',
      body: JSON.stringify({ query, size: 48, page }),
    });
    if (!r.ok) return res.status(500).json({ error: `Immich error ${r.status}` });
    const data = await r.json();
    const assets = data?.assets?.items || [];
    const hasMore = !!data?.assets?.nextPage;
    if (!assets.length) return res.json({ photos: [], hasMore: false });

    const conn = db();
    const showHidden = res.locals.showHidden;
    const hf = showHidden ? '' : 'AND p.hidden=0';
    const photos = [];
    for (const asset of assets) {
      if (!asset.originalPath) continue;
      const winPath = immichPathToWin(asset.originalPath);
      const photo = conn.prepare(`
        SELECT p.id, p.filename, p.hidden, p.favorite,
               r.id as roll_id, r.film_stock, r.rel_path, c.name as camera_name
        FROM photos p JOIN rolls r ON r.id=p.roll_id JOIN cameras c ON c.id=r.camera_id
        WHERE p.file_path=? ${hf}
      `).get(winPath);
      if (photo) photos.push(photo);
    }
    conn.close();
    res.json({ photos, hasMore });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── people / faces (Immich) ───────────────────────────────────────────────────

function immichPathToWin(p) {
  return p.replace(/^\/photos\//, 'C:\\Users\\aleez\\Desktop\\Photos\\Aleezas Photo Database\\').replace(/\//g, '\\');
}

async function getImmichPersonPhotos(personId, conn) {
  const photos = [];
  let page = 1;
  while (true) {
    const r = await immichFetch('/api/search/metadata', {
      method: 'POST',
      body: JSON.stringify({ personIds: [personId], size: 200, page }),
    });
    if (!r.ok) break;
    const data = await r.json();
    const assets = data?.assets?.items || [];
    for (const asset of assets) {
      if (!asset.originalPath) continue;
      const winPath = immichPathToWin(asset.originalPath);
      const photo = conn.prepare(`
        SELECT p.id, p.filename, p.file_path, p.hidden, p.favorite, p.immich_id,
               r.id as roll_id, r.rel_path, r.film_stock, c.name as camera_name
        FROM photos p JOIN rolls r ON r.id=p.roll_id JOIN cameras c ON c.id=r.camera_id
        WHERE p.file_path=?
      `).get(winPath);
      if (photo) {
        if (!photo.immich_id && asset.id) {
          conn.prepare('UPDATE photos SET immich_id=? WHERE id=?').run(asset.id, photo.id);
          photo.immich_id = asset.id;
        }
        photos.push(photo);
      }
    }
    if (!data?.assets?.nextPage) break;
    page++;
  }
  return photos;
}

app.get('/people', async (req, res) => {
  try {
    // Fetch all people across pages
    const persons = [];
    let page = 1;
    let immichTotal = 0;
    while (true) {
      const r = await immichFetch(`/api/people?withHidden=false&size=500&page=${page}`);
      if (!r.ok) break;
      const data = await r.json();
      immichTotal = data.total || 0;
      for (const p of (data.people || [])) {
        persons.push({ id: p.id, name: p.name || null, cover_face_id: p.id, all_hidden: p.isHidden || false, immich: true });
      }
      if (!data.hasNextPage) break;
      page++;
    }
    res.render('people', { page: 'people', persons, personTotal: immichTotal, scanned: 1, total: 1 });
  } catch (e) {
    res.render('people', { page: 'people', persons: [], personTotal: 0, scanned: 0, total: 1 });
  }
});

app.get('/person/:id', async (req, res) => {
  try {
    const pr = await immichFetch(`/api/people/${req.params.id}`);
    if (!pr.ok) return res.status(404).end();
    const person = await pr.json();
    const conn = db();
    const photos = await getImmichPersonPhotos(req.params.id, conn);
    const settings = conn.prepare('SELECT is_hijabi FROM person_settings WHERE immich_id=?').get(req.params.id);
    conn.close();
    res.render('person', {
      page: 'people',
      person: { id: person.id, name: person.name || null, cover_face_id: person.id, isHidden: !!person.isHidden, immich: true },
      photos,
      allHidden: photos.length > 0 && photos.every(p => p.hidden === 1),
      isHijabi: !!(settings?.is_hijabi),
    });
  } catch (e) {
    res.status(500).end();
  }
});

const OLLAMA_URL = (process.env.OLLAMA_URL || 'http://localhost:11434').replace(/\/$/, '');

// Crop this person's face+head region and ask llava if they're wearing hijab.
// Bounding box coords are in Immich's processing size — scale to actual file dimensions.
// Returns 'hair' | 'hijab' | 'uncertain'
async function analyzeHeadForHair(filePath, face) {
  try {
    let meta;
    try {
      meta = await sharp(filePath).metadata();
    } catch(e) {
      console.error('[sharp] metadata fail:', filePath.slice(-50), e.message);
      throw e;
    }
    const scaleX = meta.width  / face.imageWidth;
    const scaleY = meta.height / face.imageHeight;

    const x1 = Math.round(face.boundingBoxX1 * scaleX);
    const y1 = Math.round(face.boundingBoxY1 * scaleY);
    const x2 = Math.round(face.boundingBoxX2 * scaleX);
    const y2 = Math.round(face.boundingBoxY2 * scaleY);
    const faceW = x2 - x1, faceH = y2 - y1;

    const pad    = 0.4;
    const cropX  = Math.max(0, Math.floor(x1 - faceW * pad));
    const cropW  = Math.min(meta.width  - cropX, Math.ceil(faceW * (1 + 2 * pad)));
    const aboveH = Math.floor(faceH * 1.2);
    const belowH = Math.floor(faceH * 0.3);
    const cropY  = Math.max(0, y1 - aboveH);
    const cropH  = Math.min(meta.height - cropY, aboveH + faceH + belowH);

    console.log('[sharp] extract:', { left: cropX, top: cropY, width: cropW, height: cropH }, 'imgSize:', meta.width, meta.height);
    const buf = await sharp(filePath)
      .extract({ left: cropX, top: cropY, width: cropW, height: Math.max(1, cropH) })
      .resize(400, 400, { fit: 'inside' })
      .jpeg({ quality: 90 })
      .toBuffer();

    const r = await fetch(`${OLLAMA_URL}/api/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'llava:7b',
        prompt: 'Look only at the main person in this image. Are they wearing a hijab or headscarf? Answer "hijab" if they have a hijab on, even if a small amount of baby hair or hairline is visible at the edges. Answer "hair" only if their hair is clearly and fully uncovered with no hijab present. Reply with exactly one word: "hair" or "hijab".',
        images: [buf.toString('base64')],
        stream: false,
      }),
    });

    if (!r.ok) return 'uncertain';
    const d = await r.json();
    const answer = (d.response || '').toLowerCase().trim();
    console.log(`[llava raw] "${answer.slice(0, 80)}"`);
    if (answer.includes('hijab') || answer.includes('headscarf') || answer.includes('covered') || answer.includes('scarf')) return 'hijab';
    if (answer.includes('hair') || answer.includes('visible')) return 'hair';
    return 'uncertain';
  } catch (e) {
    console.error('[analyzeHeadForHair] error:', e.message);
    return 'uncertain';
  }
}

// Hijabi review page — loads instantly, streams analysis results via SSE
app.get('/person/:id/hijabi-review', async (req, res) => {
  try {
    const pr = await immichFetch(`/api/people/${req.params.id}`);
    if (!pr.ok) return res.status(404).end();
    const person = await pr.json();
    const conn = db();
    const allPhotos = await getImmichPersonPhotos(req.params.id, conn);
    conn.close();
    res.render('hijabi-review', {
      page: 'people',
      person: { id: person.id, name: person.name || null },
      allPhotos,
    });
  } catch (e) {
    res.status(500).end();
  }
});

// SSE stream — prefetches Immich data in parallel, then runs llava sequentially
app.get('/person/:id/hijabi-stream', async (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  const send = data => res.write(`data: ${JSON.stringify(data)}\n\n`);

  try {
    const conn = db();
    const allPhotos = await getImmichPersonPhotos(req.params.id, conn);
    conn.close();

    send({ total: allPhotos.length });

    // Prefetch all Immich asset data in parallel (fast)
    const assetResults = await Promise.all(allPhotos.map(async photo => {
      if (!photo.immich_id) return null;
      const r = await immichFetch(`/api/assets/${photo.immich_id}`);
      return r.ok ? r.json() : null;
    }));

    // Run llava sequentially (Ollama handles one at a time)
    for (let i = 0; i < allPhotos.length; i++) {
      const photo = allPhotos[i];
      const asset = assetResults[i];
      const personEntry = (asset?.people || []).find(p => p.id === req.params.id);
      const face = personEntry?.faces?.[0];
      let result = 'uncertain';
      if (face && photo.file_path) {
        result = await analyzeHeadForHair(photo.file_path, face);
      }
      send({ id: photo.id, result, done: i + 1, total: allPhotos.length });
    }
    send({ finished: true });
  } catch (e) {
    send({ error: e.message });
  }
  res.end();
});

// Apply hijabi review — hide exactly the IDs the user confirmed
app.post('/api/person/:id/hijabi-apply', async (req, res) => {
  const { hideIds } = req.body;
  if (!Array.isArray(hideIds)) return res.status(400).json({ error: 'hideIds array required' });
  const conn = db();
  conn.prepare(`
    INSERT INTO person_settings (immich_id, is_hijabi) VALUES (?, 1)
    ON CONFLICT(immich_id) DO UPDATE SET is_hijabi=1
  `).run(req.params.id);
  conn.transaction(() => {
    for (const id of hideIds) conn.prepare('UPDATE photos SET hidden=1 WHERE id=?').run(id);
  })();
  conn.close();
  res.json({ ok: true, hidden: hideIds.length });
});

// Proxy Immich person thumbnail
app.get('/immich-person-thumb/:id', async (req, res) => {
  try {
    const r = await fetch(`${IMMICH_URL}/api/people/${req.params.id}/thumbnail`, {
      headers: { 'x-api-key': IMMICH_KEY },
    });
    if (!r.ok) return res.status(404).end();
    const buf = Buffer.from(await r.arrayBuffer());
    res.setHeader('Content-Type', r.headers.get('content-type') || 'image/jpeg');
    res.send(buf);
  } catch {
    res.status(500).end();
  }
});


app.get('/api/persons/search', async (req, res) => {
  const q = (req.query.q || '').trim().toLowerCase();
  if (!q) return res.json([]);
  const r = await immichFetch('/api/people?withHidden=false&size=500');
  if (!r.ok) return res.json([]);
  const data = await r.json();
  const matches = (data.people || [])
    .filter(p => p.name && p.name.toLowerCase().includes(q))
    .slice(0, 8)
    .map(p => ({ id: p.id, name: p.name, cover_face_id: p.id }));
  res.json(matches);
});

app.post('/api/person/:id/name', async (req, res) => {
  const r = await immichFetch(`/api/people/${req.params.id}`, {
    method: 'PUT',
    body: JSON.stringify({ name: req.body.name || '' }),
  });
  res.json({ ok: r.ok });
});

app.post('/api/persons/merge', async (req, res) => {
  const { into, from: fromId } = req.body;
  if (!into || !fromId || into === fromId) return res.status(400).json({ error: 'Invalid' });
  const r = await immichFetch(`/api/people/${into}/merge`, {
    method: 'POST',
    body: JSON.stringify({ ids: [fromId] }),
  });
  res.json({ ok: r.ok });
});

app.post('/api/person/:id/hide', async (req, res) => {
  const hidden = req.body.hidden ? 1 : 0;
  const conn = db();
  const photos = await getImmichPersonPhotos(req.params.id, conn);
  conn.transaction(() => {
    for (const p of photos) conn.prepare('UPDATE photos SET hidden=? WHERE id=?').run(hidden, p.id);
  })();
  conn.close();
  res.json({ ok: true, hidden: !!hidden });
});

// Remove from People + hide all photos
app.post('/api/person/:id/remove', async (req, res) => {
  await immichFetch(`/api/people/${req.params.id}`, {
    method: 'PUT',
    body: JSON.stringify({ isHidden: true }),
  });
  const conn = db();
  const photos = await getImmichPersonPhotos(req.params.id, conn);
  conn.transaction(() => {
    for (const p of photos) conn.prepare('UPDATE photos SET hidden=1 WHERE id=?').run(p.id);
  })();
  conn.close();
  res.json({ ok: true });
});

// Remove from People only — hides person in Immich, leaves photos visible
app.post('/api/person/:id/remove-only', async (req, res) => {
  const r = await immichFetch(`/api/people/${req.params.id}`, {
    method: 'PUT',
    body: JSON.stringify({ isHidden: true }),
  });
  res.json({ ok: r.ok });
});

// Restore a hidden person back to the People page
app.post('/api/person/:id/unhide-person', async (req, res) => {
  const r = await immichFetch(`/api/people/${req.params.id}`, {
    method: 'PUT',
    body: JSON.stringify({ isHidden: false }),
  });
  res.json({ ok: r.ok });
});

// Set cover photo for a person (featureFaceAssetId = Immich asset UUID)
app.post('/api/person/:id/cover-photo', async (req, res) => {
  const { assetId } = req.body;
  if (!assetId) return res.status(400).json({ error: 'assetId required' });
  const r = await immichFetch(`/api/people/${req.params.id}`, {
    method: 'PUT',
    body: JSON.stringify({ featureFaceAssetId: assetId }),
  });
  res.json({ ok: r.ok });
});

// Toggle hijabi flag — uses CLIP to find hijab photos, hides the rest (hair visible)
app.post('/api/person/:id/hijabi', async (req, res) => {
  const { hijabi } = req.body;
  const conn = db();
  conn.prepare(`
    INSERT INTO person_settings (immich_id, is_hijabi) VALUES (?, ?)
    ON CONFLICT(immich_id) DO UPDATE SET is_hijabi=excluded.is_hijabi
  `).run(req.params.id, hijabi ? 1 : 0);

  const allPhotos = await getImmichPersonPhotos(req.params.id, conn);

  if (!hijabi) {
    // Toggling off — unhide all their photos
    conn.transaction(() => {
      for (const p of allPhotos) conn.prepare('UPDATE photos SET hidden=0 WHERE id=?').run(p.id);
    })();
    conn.close();
    return res.json({ ok: true, hijabi: false });
  }

  // Find photos of this person where they're wearing hijab via CLIP smart search.
  // We search with personIds so results are already scoped to this person.
  const hijabAssetIds = new Set();
  for (const query of ['hijab headscarf', 'hair covered headscarf', 'hijab niqab']) {
    let page = 1;
    while (true) {
      const r = await immichFetch('/api/search/smart', {
        method: 'POST',
        body: JSON.stringify({ query, personIds: [req.params.id], size: 200, page }),
      });
      if (!r.ok) break;
      const data = await r.json();
      for (const asset of (data?.assets?.items || [])) {
        if (asset.id) hijabAssetIds.add(asset.id);
      }
      if (!data?.assets?.nextPage) break;
      page++;
    }
  }

  // Hide photos NOT found in hijab results (hair is visible); unhide those that are
  let hiddenCount = 0;
  conn.transaction(() => {
    for (const p of allPhotos) {
      const wearingHijab = p.immich_id && hijabAssetIds.has(p.immich_id);
      conn.prepare('UPDATE photos SET hidden=? WHERE id=?').run(wearingHijab ? 0 : 1, p.id);
      if (!wearingHijab) hiddenCount++;
    }
  })();
  conn.close();
  res.json({ ok: true, hijabi: true, total: allPhotos.length, hidden: hiddenCount });
});


// ── Duplicate scanner ─────────────────────────────────────────────────────────

let dupScanState = null; // null | { status, scanned, total, groups }

function computeFileHash(filePath) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('md5');
    const stream = fs.createReadStream(filePath);
    stream.on('data', chunk => hash.update(chunk));
    stream.on('end', () => resolve(hash.digest('hex')));
    stream.on('error', () => resolve(null));
  });
}

app.get('/duplicates', (req, res) => {
  res.render('duplicates', { page: 'duplicates', breadcrumbs: [] });
});

app.get('/api/duplicates/status', (req, res) => {
  res.json(dupScanState || { status: 'idle' });
});

app.post('/api/duplicates/scan', async (req, res) => {
  if (dupScanState && dupScanState.status === 'scanning') {
    return res.json({ ok: false, error: 'Scan already running' });
  }

  dupScanState = { status: 'scanning', scanned: 0, total: 0, groups: [] };
  res.json({ ok: true });

  // Run in background
  (async () => {
    const conn = db();
    const photos = conn.prepare(
      'SELECT p.id, p.file_path, p.filename, r.rel_path, r.id as roll_id FROM photos p JOIN rolls r ON p.roll_id=r.id WHERE p.hidden=0'
    ).all();
    conn.close();

    // Step 1: group by file size (fast, no hashing needed for different sizes)
    const sizeGroups = new Map();
    for (const p of photos) {
      try {
        const size = fs.statSync(p.file_path).size;
        if (!sizeGroups.has(size)) sizeGroups.set(size, []);
        sizeGroups.get(size).push(p);
      } catch {}
    }

    // Only hash files that share a size with at least one other file
    const candidates = [...sizeGroups.values()].filter(g => g.length > 1).flat();
    dupScanState.total = candidates.length;

    const hashGroups = new Map();
    for (const p of candidates) {
      const hash = await computeFileHash(p.file_path);
      if (!hash) { dupScanState.scanned++; continue; }
      if (!hashGroups.has(hash)) hashGroups.set(hash, []);
      hashGroups.get(hash).push(p);
      dupScanState.scanned++;
    }

    const groups = [...hashGroups.values()]
      .filter(g => g.length > 1)
      .map(g => g.map(p => ({ ...p, file_size: (() => { try { return fs.statSync(p.file_path).size; } catch { return 0; } })() })));

    dupScanState = { status: 'done', scanned: candidates.length, total: candidates.length, groups, count: groups.length };
  })().catch(err => {
    dupScanState = { status: 'error', error: err.message };
  });
});

// ─────────────────────────────────────────────────────────────────────────────

const PORT = 5000;
app.listen(PORT, () => console.log(`Film Archive → http://localhost:${PORT}`));
