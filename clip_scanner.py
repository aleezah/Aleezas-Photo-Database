"""
CLIP image scanner for film-db.
Encodes photos with CLIP, stores embeddings, and auto-tags with detected concepts.

Usage:
  python clip_scanner.py scan          # encode film photos only
  python clip_scanner.py scan --all    # encode all photos
  python clip_scanner.py search <query> [--limit 20]
  python clip_scanner.py autotag       # apply auto-tags to encoded photos
"""

import sqlite3
import json
import os
import sys
import time
import numpy as np

DB_PATH    = os.path.join(os.path.dirname(__file__), 'film.db')
MODEL_NAME = 'ViT-B-32'
PRETRAINED = 'openai'

# ── Auto-tag categories ───────────────────────────────────────────────────────
# Format: (tag_name, clip_prompt, threshold)
# Lower threshold = tag more photos; higher = stricter
AUTO_TAGS = [
    # Animals
    ('cat',         'a photo of a cat',                         0.24),
    ('dog',         'a photo of a dog',                         0.24),
    ('bird',        'a photo of a bird',                        0.22),
    ('horse',       'a photo of a horse',                       0.22),
    # Fashion
    ('dress',       'a person wearing a dress',                 0.22),
    ('hijab',       'a person wearing a hijab or headscarf',    0.22),
    ('suit',        'a person wearing a suit',                  0.21),
    ('hat',         'a person wearing a hat',                   0.21),
    # Scenes
    ('beach',       'a beach or ocean scene',                   0.23),
    ('mountain',    'a mountain or hiking scene',               0.22),
    ('forest',      'trees or a forest',                        0.21),
    ('city',        'a city street or urban scene',             0.22),
    ('indoors',     'an indoor scene',                          0.23),
    ('night',       'a nighttime photo',                        0.22),
    ('snow',        'snow or winter scene',                     0.23),
    ('sunset',      'a sunset or sunrise',                      0.23),
    ('pool',        'a swimming pool',                          0.22),
    ('garden',      'a garden or park',                         0.21),
    # Events
    ('birthday',    'a birthday party with cake',               0.21),
    ('wedding',     'a wedding ceremony or celebration',        0.22),
    ('graduation',  'a graduation ceremony',                    0.21),
    ('concert',     'a concert or live music event',            0.22),
    # Food & drink
    ('food',        'a photo of food or a meal',                0.23),
    ('cake',        'a cake or dessert',                        0.22),
    ('coffee',      'a coffee or cafe',                         0.21),
    # Other
    ('selfie',      'a selfie or self-portrait',                0.21),
    ('group photo', 'a group photo with multiple people',       0.22),
    ('baby',        'a baby or young child',                    0.23),
    ('travel',      'a travel or tourist photo',                0.21),
    ('car',         'a car or vehicle',                         0.21),
]

AUTO_TAG_PREFIX = 'clip:'   # prefix so auto-tags are distinguishable from user tags


# ── DB setup ──────────────────────────────────────────────────────────────────

def get_conn():
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    conn.execute('''
        CREATE TABLE IF NOT EXISTS photo_embeddings (
            photo_id  INTEGER PRIMARY KEY REFERENCES photos(id),
            embedding TEXT NOT NULL
        )
    ''')
    conn.commit()
    return conn


# ── Load model ────────────────────────────────────────────────────────────────

def load_model():
    import open_clip
    import torch
    print(f"Loading CLIP model ({MODEL_NAME})...")
    model, _, preprocess = open_clip.create_model_and_transforms(MODEL_NAME, pretrained=PRETRAINED)
    model.eval()
    tokenizer = open_clip.get_tokenizer(MODEL_NAME)
    return model, preprocess, tokenizer


# ── Scan ──────────────────────────────────────────────────────────────────────

def scan(film_only=True):
    from PIL import Image
    import torch

    conn = get_conn()
    cat_filter = "AND c.name LIKE '35mm prints / %'" if film_only else ""

    photos = conn.execute(f'''
        SELECT p.id, p.file_path FROM photos p
        JOIN rolls r   ON p.roll_id   = r.id
        JOIN cameras c ON r.camera_id = c.id
        WHERE p.id NOT IN (SELECT photo_id FROM photo_embeddings)
        {cat_filter}
        ORDER BY p.id
    ''').fetchall()

    total = len(photos)
    if total == 0:
        print("All photos already encoded.")
        conn.close()
        return

    model, preprocess, _ = load_model()
    print(f"Encoding {total} photos{'  (film only)' if film_only else ''}...\n")

    BATCH = 16
    done  = 0
    start = time.time()

    for i in range(0, total, BATCH):
        batch   = photos[i:i + BATCH]
        tensors = []
        ids     = []

        for photo in batch:
            try:
                img = Image.open(photo['file_path']).convert('RGB')
                tensors.append(preprocess(img))
                ids.append(photo['id'])
            except Exception:
                continue

        if not tensors:
            continue

        with torch.no_grad():
            stack    = torch.stack(tensors)
            features = model.encode_image(stack)
            features = features / features.norm(dim=-1, keepdim=True)
            embs     = features.cpu().numpy()

        for pid, emb in zip(ids, embs):
            conn.execute(
                'INSERT OR REPLACE INTO photo_embeddings (photo_id, embedding) VALUES (?,?)',
                (pid, json.dumps(emb.tolist()))
            )

        done += len(ids)
        conn.commit()

        if done % 200 == 0 or done == total:
            elapsed   = time.time() - start
            per_photo = elapsed / done
            remaining = int(per_photo * (total - done))
            m, s = divmod(remaining, 60)
            h, m = divmod(m, 60)
            eta = f"{h}h {m}m" if h else f"{m}m {s}s"
            print(f"  {done}/{total}  |  ETA {eta}", flush=True)

    elapsed = int(time.time() - start)
    print(f"\nDone. {done} photos encoded in {elapsed//60}m {elapsed%60}s.")
    conn.close()


# ── Auto-tag ──────────────────────────────────────────────────────────────────

def autotag():
    import torch

    conn = get_conn()

    rows = conn.execute('SELECT photo_id, embedding FROM photo_embeddings').fetchall()
    if not rows:
        print("No embeddings found — run scan first.")
        conn.close()
        return

    print(f"Auto-tagging {len(rows)} photos with {len(AUTO_TAGS)} categories...")

    model, _, tokenizer = load_model()

    # Encode all tag prompts
    with torch.no_grad():
        texts    = tokenizer([t[1] for t in AUTO_TAGS])
        text_emb = model.encode_text(texts)
        text_emb = text_emb / text_emb.norm(dim=-1, keepdim=True)
        text_np  = text_emb.cpu().numpy()

    # Load all image embeddings
    ids  = [r['photo_id'] for r in rows]
    embs = np.array([json.loads(r['embedding']) for r in rows], dtype=np.float32)

    # Cosine similarity: (n_photos, n_tags)
    sims = embs @ text_np.T

    # Ensure tag entries exist
    for tag_name, _, _ in AUTO_TAGS:
        full = AUTO_TAG_PREFIX + tag_name
        conn.execute('INSERT OR IGNORE INTO tags (name) VALUES (?)', (full,))
    conn.commit()

    # Remove old auto-tags
    conn.execute('''
        DELETE FROM photo_tags WHERE tag_id IN (
            SELECT id FROM tags WHERE name LIKE ?
        )
    ''', (AUTO_TAG_PREFIX + '%',))
    conn.commit()

    tagged = 0
    for i, photo_id in enumerate(ids):
        for j, (tag_name, _, threshold) in enumerate(AUTO_TAGS):
            if float(sims[i, j]) >= threshold:
                full = AUTO_TAG_PREFIX + tag_name
                tag_id = conn.execute('SELECT id FROM tags WHERE name=?', (full,)).fetchone()['id']
                conn.execute('INSERT OR IGNORE INTO photo_tags (photo_id, tag_id) VALUES (?,?)',
                             (photo_id, tag_id))
                tagged += 1

    conn.commit()
    conn.close()
    print(f"Done. {tagged} tags applied across {len(ids)} photos.")


# ── Search ────────────────────────────────────────────────────────────────────

def search(query, limit=20):
    import torch

    conn = get_conn()
    rows = conn.execute('SELECT photo_id, embedding FROM photo_embeddings').fetchall()
    if not rows:
        print(json.dumps([]))
        conn.close()
        return

    model, _, tokenizer = load_model()

    with torch.no_grad():
        tokens   = tokenizer([query])
        text_emb = model.encode_text(tokens)
        text_emb = text_emb / text_emb.norm(dim=-1, keepdim=True)
        text_np  = text_emb.cpu().numpy()[0]

    ids  = [r['photo_id'] for r in rows]
    embs = np.array([json.loads(r['embedding']) for r in rows], dtype=np.float32)
    sims = embs @ text_np

    top_idx = np.argsort(sims)[::-1][:limit]
    results = [{'id': ids[i], 'score': float(sims[i])} for i in top_idx if sims[i] > 0.18]

    print(json.dumps(results))
    conn.close()


# ── Entry point ───────────────────────────────────────────────────────────────

if __name__ == '__main__':
    cmd      = sys.argv[1] if len(sys.argv) > 1 else 'scan'
    scan_all = '--all' in sys.argv

    if cmd == 'scan':
        scan(film_only=not scan_all)
    elif cmd == 'autotag':
        autotag()
    elif cmd == 'search':
        query = sys.argv[2] if len(sys.argv) > 2 else ''
        limit = int(sys.argv[4]) if '--limit' in sys.argv else 20
        if not query:
            print(json.dumps([]))
        else:
            search(query, limit)
    elif cmd == 'run':
        scan(film_only=not scan_all)
        autotag()
    else:
        print(__doc__)
