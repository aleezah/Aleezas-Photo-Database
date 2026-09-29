const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

// Guards against wiping the database when the photos drive is simply disconnected
// or the wrong path is configured — that looks identical to "everything got moved".
const ABORT_RATIO = 0.3;

// Removes rows (and their cached thumbnails) for photos whose file no longer exists
// on disk, then rolls left empty or whose folder is gone, then cameras left with no
// rolls. This is what cleans up the leftovers when a folder gets renamed or photos get
// moved outside the app — the scanner adds the new path but never removes the old row.
//
// Note: renaming a folder is indistinguishable from "delete old + add new" here, so any
// notes/film stock/hidden flag/share link/tags on the old roll or its photos are lost,
// not carried over to the freshly-scanned replacement.
function pruneMissing(db, baseDir, { force = false } = {}) {
  const THUMBS_DIR = path.join(baseDir, 'thumbs');
  const WEB_CACHE_DIR = path.join(THUMBS_DIR, 'web');
  const thumbFor = filePath =>
    path.join(THUMBS_DIR, crypto.createHash('md5').update(filePath).digest('hex') + '.jpg');

  const allPhotos = db.prepare('SELECT id, file_path FROM photos').all();
  const missingPhotos = allPhotos.filter(p => !fs.existsSync(p.file_path));
  const missingRatio = allPhotos.length ? missingPhotos.length / allPhotos.length : 0;

  if (!force && allPhotos.length > 0 && missingRatio > ABORT_RATIO) {
    return {
      aborted: true,
      reason: `${missingPhotos.length} of ${allPhotos.length} photos (${Math.round(missingRatio * 100)}%) ` +
        `appear missing — that looks more like a disconnected drive or wrong path than real renames. Re-run with force to proceed anyway.`,
      removedPhotos: 0, removedRolls: 0, removedCameras: 0,
    };
  }

  const getFaceIds       = db.prepare('SELECT id FROM faces WHERE photo_id=?');
  const clearPersonCover = db.prepare('UPDATE persons SET cover_face_id=NULL WHERE cover_face_id=?');
  const delFacePersons   = db.prepare('DELETE FROM face_persons WHERE face_id=?');
  const clearRollCover   = db.prepare('UPDATE rolls SET cover_photo_id=NULL WHERE cover_photo_id=?');
  const delEmbeddings    = db.prepare('DELETE FROM photo_embeddings WHERE photo_id=?');
  const delFaces         = db.prepare('DELETE FROM faces WHERE photo_id=?');
  const delPhotoTags     = db.prepare('DELETE FROM photo_tags WHERE photo_id=?');
  const delPhoto         = db.prepare('DELETE FROM photos WHERE id=?');

  db.transaction(rows => {
    for (const p of rows) {
      for (const f of getFaceIds.all(p.id)) {
        clearPersonCover.run(f.id);
        delFacePersons.run(f.id);
      }
      clearRollCover.run(p.id);
      delEmbeddings.run(p.id);
      delFaces.run(p.id);
      delPhotoTags.run(p.id);
      delPhoto.run(p.id);
    }
  })(missingPhotos);

  for (const p of missingPhotos) {
    for (const f of [
      thumbFor(p.file_path),
      path.join(THUMBS_DIR, 'display', `${p.id}.jpg`),
      path.join(WEB_CACHE_DIR, `${p.id}.mp4`),
    ]) {
      try { if (fs.existsSync(f)) fs.unlinkSync(f); } catch {}
    }
  }

  const photoCounts = new Map(
    db.prepare('SELECT roll_id, COUNT(*) as n FROM photos GROUP BY roll_id').all().map(r => [r.roll_id, r.n])
  );
  const staleRolls = db.prepare('SELECT id, folder_path FROM rolls').all()
    .filter(r => !fs.existsSync(r.folder_path) || !photoCounts.get(r.id));

  const delRoll = db.prepare('DELETE FROM rolls WHERE id=?');
  db.transaction(rows => { for (const r of rows) delRoll.run(r.id); })(staleRolls);

  const rollCounts = new Map(
    db.prepare('SELECT camera_id, COUNT(*) as n FROM rolls GROUP BY camera_id').all().map(r => [r.camera_id, r.n])
  );
  const staleCameras = db.prepare('SELECT id FROM cameras').all().filter(c => !rollCounts.get(c.id));

  const delCamera = db.prepare('DELETE FROM cameras WHERE id=?');
  db.transaction(rows => { for (const c of rows) delCamera.run(c.id); })(staleCameras);

  return {
    aborted: false,
    removedPhotos: missingPhotos.length,
    removedRolls: staleRolls.length,
    removedCameras: staleCameras.length,
  };
}

module.exports = { pruneMissing };
