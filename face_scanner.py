"""
Face scanner for film-db.
Usage:
  python face_scanner.py scan          # scan film photos only
  python face_scanner.py scan --all    # scan all photos (film + digital)
  python face_scanner.py cluster       # cluster scanned faces into person groups
  python face_scanner.py run           # scan + cluster (film only)
  python face_scanner.py run --all     # scan + cluster (all photos)
"""

import sqlite3
import json
import os
import sys
import time
import numpy as np

DB_PATH   = os.path.join(os.path.dirname(__file__), 'film.db')
THRESHOLD = 0.72  # cosine distance threshold — lower = stricter matching


# ── DB setup ──────────────────────────────────────────────────────────────────

def init_tables(conn):
    conn.executescript('''
        CREATE TABLE IF NOT EXISTS faces (
            id         INTEGER PRIMARY KEY,
            photo_id   INTEGER NOT NULL REFERENCES photos(id),
            box_x      INTEGER,
            box_y      INTEGER,
            box_w      INTEGER,
            box_h      INTEGER,
            embedding  TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS persons (
            id             INTEGER PRIMARY KEY,
            name           TEXT,
            cover_face_id  INTEGER REFERENCES faces(id)
        );
        CREATE TABLE IF NOT EXISTS face_persons (
            face_id   INTEGER NOT NULL REFERENCES faces(id),
            person_id INTEGER NOT NULL REFERENCES persons(id),
            PRIMARY KEY (face_id, person_id)
        );
        CREATE INDEX IF NOT EXISTS idx_faces_photo ON faces(photo_id);
    ''')
    conn.commit()


# ── Scan ──────────────────────────────────────────────────────────────────────

def scan(film_only=True):
    import cv2
    from insightface.app import FaceAnalysis

    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    init_tables(conn)

    cat_filter = "AND c.name LIKE '35mm prints / %'" if film_only else ""
    photos = conn.execute(f'''
        SELECT p.id, p.file_path
        FROM photos p
        JOIN rolls r   ON p.roll_id    = r.id
        JOIN cameras c ON r.camera_id  = c.id
        WHERE p.id NOT IN (SELECT DISTINCT photo_id FROM faces)
        {cat_filter}
        ORDER BY p.id
    ''').fetchall()

    total = len(photos)
    if total == 0:
        print("All photos already scanned.")
        conn.close()
        return

    print(f"Loading face model...")
    fa = FaceAnalysis(name='buffalo_sc', allowed_modules=['detection', 'recognition'])
    fa.prepare(ctx_id=-1, det_size=(640, 640))
    print(f"Scanning {total} photos{'  (film only)' if film_only else ''}...\n")

    done = 0
    found_faces = 0
    start = time.time()

    for photo in photos:
        try:
            img = cv2.imread(photo['file_path'])
            if img is None:
                done += 1
                continue

            faces = fa.get(img)
            for face in faces:
                box = face.bbox.astype(int)
                conn.execute(
                    'INSERT INTO faces (photo_id, box_x, box_y, box_w, box_h, embedding) VALUES (?,?,?,?,?,?)',
                    (photo['id'],
                     int(box[0]), int(box[1]),
                     int(box[2] - box[0]), int(box[3] - box[1]),
                     json.dumps(face.embedding.tolist()))
                )
                found_faces += 1

            done += 1
            if done % 50 == 0:
                conn.commit()
                elapsed  = time.time() - start
                per_photo = elapsed / done
                remaining = int(per_photo * (total - done))
                mins, secs = divmod(remaining, 60)
                hrs,  mins = divmod(mins, 60)
                eta = f"{hrs}h {mins}m" if hrs else f"{mins}m {secs}s"
                print(f"  {done}/{total}  |  {found_faces} faces found  |  ETA {eta}", flush=True)

        except Exception as e:
            done += 1
            print(f"  [skip] photo {photo['id']}: {e}")
            continue

    conn.commit()
    elapsed = int(time.time() - start)
    print(f"\nDone. {done} photos in {elapsed//60}m {elapsed%60}s — {found_faces} faces detected.")
    conn.close()


# ── Cluster ───────────────────────────────────────────────────────────────────

def cluster():
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    init_tables(conn)

    rows = conn.execute('SELECT id, embedding FROM faces').fetchall()
    if not rows:
        print("No faces in DB yet — run scan first.")
        conn.close()
        return

    print(f"Clustering {len(rows)} faces (threshold={THRESHOLD})...")

    ids  = [r['id'] for r in rows]
    embs = np.array([json.loads(r['embedding']) for r in rows], dtype=np.float32)

    # Normalise for cosine similarity
    norms = np.linalg.norm(embs, axis=1, keepdims=True)
    embs  = embs / np.maximum(norms, 1e-10)

    # Greedy clustering: O(n²) but fine for <100k faces
    assigned = {}   # face_id -> cluster index
    clusters = []   # list of [face_id, ...]

    for i, fid in enumerate(ids):
        if fid in assigned:
            continue
        group = [fid]
        for j in range(i + 1, len(ids)):
            other = ids[j]
            if other in assigned:
                continue
            if float(np.dot(embs[i], embs[j])) >= (1.0 - THRESHOLD):
                group.append(other)
                assigned[other] = len(clusters)
        assigned[fid] = len(clusters)
        clusters.append(group)

    # Rebuild persons table (keep existing names where person_id matches)
    existing_names = {r['id']: r['name'] for r in conn.execute('SELECT id, name FROM persons').fetchall()}

    conn.execute('DELETE FROM face_persons')
    conn.execute('DELETE FROM persons')

    for idx, group in enumerate(clusters):
        old_name = existing_names.get(idx + 1)
        cur = conn.execute(
            'INSERT INTO persons (name, cover_face_id) VALUES (?,?)',
            (old_name, group[0])
        )
        pid = cur.lastrowid
        conn.executemany(
            'INSERT INTO face_persons (face_id, person_id) VALUES (?,?)',
            [(fid, pid) for fid in group]
        )

    conn.commit()
    conn.close()

    solo  = sum(1 for g in clusters if len(g) == 1)
    multi = len(clusters) - solo
    print(f"Done. {len(clusters)} person groups ({multi} with 2+ faces, {solo} singletons).")


# ── Entry point ───────────────────────────────────────────────────────────────

if __name__ == '__main__':
    cmd      = sys.argv[1] if len(sys.argv) > 1 else 'run'
    scan_all = '--all' in sys.argv

    if cmd == 'scan':
        scan(film_only=not scan_all)
    elif cmd == 'cluster':
        cluster()
    elif cmd in ('run', 'all'):
        scan(film_only=not scan_all)
        cluster()
    else:
        print(__doc__)
