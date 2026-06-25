const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

const PHOTOS_DIR = 'C:\\Users\\aleez\\Desktop\\Photos\\Aleezas Photo Database';
const DB_PATH = path.join(__dirname, 'film.db');
const IMAGE_EXTS = new Set(['.jpg', '.jpeg', '.png', '.tif', '.tiff']);

const MONTH_NAMES = [
  'january','february','march','april','may','june',
  'july','august','september','october','november','december',
  'jan','feb','mar','apr','jun','jul','aug','sep','oct','nov','dec',
];

const FILM_KEYWORDS = [
  'kodak','fuji','fujifilm','ilford','cinestill','agfa','lomography',
  'rollei','kentmere','fomapan','bergger','orwo','adox','kosmo',
  'gold','ultramax','portra','ektar','hp5','fp4','delta','tmax',
  'colorplus','proimage','superia','provia','velvia','astia','xtra',
];

function initDb(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS cameras (
      id   INTEGER PRIMARY KEY,
      name TEXT UNIQUE NOT NULL
    );
    CREATE TABLE IF NOT EXISTS rolls (
      id          INTEGER PRIMARY KEY,
      camera_id   INTEGER NOT NULL REFERENCES cameras(id),
      folder_path TEXT UNIQUE NOT NULL,
      rel_path    TEXT NOT NULL,
      year        TEXT,
      date_label  TEXT,
      film_stock      TEXT,
      notes           TEXT,
      cover_photo_id  INTEGER REFERENCES photos(id)
    );
    CREATE TABLE IF NOT EXISTS photos (
      id        INTEGER PRIMARY KEY,
      roll_id   INTEGER NOT NULL REFERENCES rolls(id),
      filename  TEXT NOT NULL,
      file_path TEXT UNIQUE NOT NULL,
      notes     TEXT,
      favorite  INTEGER DEFAULT 0,
      hidden    INTEGER DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS tags (
      id   INTEGER PRIMARY KEY,
      name TEXT UNIQUE NOT NULL
    );
    CREATE TABLE IF NOT EXISTS photo_tags (
      photo_id INTEGER NOT NULL REFERENCES photos(id),
      tag_id   INTEGER NOT NULL REFERENCES tags(id),
      PRIMARY KEY (photo_id, tag_id)
    );
  `);
}

function parseRollMetadata(parts) {
  let year = null, dateLabel = null, filmStock = null;
  for (const part of parts) {
    const p = part.toLowerCase().trim();
    if (/^\d{4}$/.test(part) && +part >= 1990 && +part <= 2099) {
      year = part;
    } else if (/^\d{4}-\d{2}-\d{2}$/.test(part)) {
      year = year || part.slice(0, 4);
      dateLabel = dateLabel || part;
    } else if (MONTH_NAMES.some(m => p.includes(m))) {
      dateLabel = dateLabel || part;
    } else if (FILM_KEYWORDS.some(k => p.includes(k))) {
      filmStock = filmStock || part;
    }
  }
  return { year, dateLabel, filmStock };
}

function walkImages(dir) {
  const results = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith('._') || entry.name === '.DS_Store') continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...walkImages(full));
    } else if (IMAGE_EXTS.has(path.extname(entry.name).toLowerCase())) {
      const stat = fs.statSync(full);
      if (stat.size > 0) results.push(full);
    }
  }
  return results;
}

// Returns flat list of { name, path } for every camera.
// If a top-level dir contains only subdirectories (no images directly),
// it's treated as a category and its children become cameras named "Category / Camera".
function getCameraEntries() {
  const entries = [];
  const topDirs = fs.readdirSync(PHOTOS_DIR, { withFileTypes: true })
    .filter(d => d.isDirectory())
    .sort((a, b) => a.name.localeCompare(b.name));

  for (const topDir of topDirs) {
    const topPath = path.join(PHOTOS_DIR, topDir.name);
    const children = fs.readdirSync(topPath, { withFileTypes: true });
    const hasDirectImages = children.some(
      e => e.isFile() && IMAGE_EXTS.has(path.extname(e.name).toLowerCase()) && !e.name.startsWith('._')
    );
    const subDirs = children.filter(e => e.isDirectory()).sort((a, b) => a.name.localeCompare(b.name));

    if (!hasDirectImages && subDirs.length > 0) {
      // Category folder — go one level deeper
      for (const sub of subDirs) {
        entries.push({ name: `${topDir.name} / ${sub.name}`, path: path.join(topPath, sub.name) });
      }
    } else {
      entries.push({ name: topDir.name, path: topPath });
    }
  }
  return entries;
}

function scan() {
  const db = new Database(DB_PATH);
  initDb(db);

  const stmts = {
    insertCamera: db.prepare('INSERT OR IGNORE INTO cameras (name) VALUES (?)'),
    getCamera:    db.prepare('SELECT id FROM cameras WHERE name = ?'),
    insertRoll:   db.prepare('INSERT OR IGNORE INTO rolls (camera_id, folder_path, rel_path, year, date_label, film_stock) VALUES (?,?,?,?,?,?)'),
    getRoll:      db.prepare('SELECT id FROM rolls WHERE folder_path = ?'),
    insertPhoto:  db.prepare('INSERT OR IGNORE INTO photos (roll_id, filename, file_path) VALUES (?,?,?)'),
  };

  let newRolls = 0, newPhotos = 0;

  for (const camera of getCameraEntries()) {
    stmts.insertCamera.run(camera.name);
    const cameraId = stmts.getCamera.get(camera.name).id;

    const images = walkImages(camera.path);

    const rollFolders = new Map();
    for (const img of images) {
      const folder = path.dirname(img);
      if (!rollFolders.has(folder)) rollFolders.set(folder, []);
      rollFolders.get(folder).push(img);
    }

    const doInsert = db.transaction(() => {
      for (const [rollFolder, rollImages] of [...rollFolders.entries()].sort()) {
        const relPath = path.relative(camera.path, rollFolder) || '.';
        const parts = relPath === '.' ? [] : relPath.split(path.sep);
        const { year, dateLabel, filmStock } = parseRollMetadata(parts);

        const r = stmts.insertRoll.run(cameraId, rollFolder, relPath, year, dateLabel, filmStock);
        if (r.changes) newRolls++;

        const rollId = stmts.getRoll.get(rollFolder).id;
        for (const img of rollImages.sort()) {
          const r2 = stmts.insertPhoto.run(rollId, path.basename(img), img);
          if (r2.changes) newPhotos++;
        }
      }
    });
    doInsert();

    console.log(`  ${camera.name}: ${images.length} photos in ${rollFolders.size} rolls`);
  }

  db.close();
  console.log(`\nScan complete — ${newRolls} new rolls, ${newPhotos} new photos indexed.`);
}

console.log(`Scanning ${PHOTOS_DIR} ...\n`);
scan();
