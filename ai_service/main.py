"""Optional AI matching service for Campus Lost & Found.

After a post is created, the web app calls POST /index/{item_id} with the user's Supabase token.
The service embeds the photo and text with CLIP, saves the embedding, finds the closest open items of
the opposite kind, and stores them in the `matches` table. Matches are suggestions only; the owner
still has to pass the hidden-detail check.
"""
import io
import os

import httpx
from fastapi import FastAPI, Header, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from PIL import Image
from sentence_transformers import SentenceTransformer

SUPABASE_URL = os.environ["SUPABASE_URL"].rstrip("/")
SERVICE_KEY = os.environ["SUPABASE_SERVICE_KEY"]   # keep secret: server only
ANON_KEY = os.environ["SUPABASE_ANON_KEY"]
ORIGINS = os.environ.get("ALLOWED_ORIGINS", "*").split(",")
THRESHOLD = float(os.environ.get("MATCH_THRESHOLD", "0.6"))  # tune on real pilot pairs
TOP_N = int(os.environ.get("MATCH_TOP_N", "5"))

app = FastAPI(title="Campus Lost & Found AI")
app.add_middleware(CORSMiddleware, allow_origins=ORIGINS, allow_methods=["POST"], allow_headers=["Authorization"])
model = SentenceTransformer("clip-ViT-B-32")  # one model for both images and text (512 dimensions)
REST = {"apikey": SERVICE_KEY, "Authorization": f"Bearer {SERVICE_KEY}", "Content-Type": "application/json"}


def normalise(vec):
    n = sum(x * x for x in vec) ** 0.5 or 1.0
    return [x / n for x in vec]


def user_id_from_token(token: str) -> str:
    r = httpx.get(f"{SUPABASE_URL}/auth/v1/user", headers={"apikey": ANON_KEY, "Authorization": f"Bearer {token}"}, timeout=15)
    if r.status_code != 200:
        raise HTTPException(401, "Invalid token")
    return r.json()["id"]


@app.get("/health")
def health():
    return {"ok": True}


@app.post("/index/{item_id}")
def index_item(item_id: str, authorization: str = Header(default="")):
    token = authorization.removeprefix("Bearer ").strip()
    if not token:
        raise HTTPException(401, "Missing token")
    uid = user_id_from_token(token)

    r = httpx.get(f"{SUPABASE_URL}/rest/v1/items", params={"id": f"eq.{item_id}", "select": "*"}, headers=REST, timeout=15)
    rows = r.json() if r.status_code == 200 else []
    if not rows:
        raise HTTPException(404, "Item not found")
    item = rows[0]
    if item["owner_id"] != uid:
        raise HTTPException(403, "Not your item")

    vectors = []
    if item.get("photo_path"):
        img = httpx.get(f"{SUPABASE_URL}/storage/v1/object/public/item-photos/{item['photo_path']}", timeout=30)
        if img.status_code == 200:
            vectors.append(model.encode(Image.open(io.BytesIO(img.content)).convert("RGB")).tolist())
    text = f"{item['name']}. {item['category']}. {item.get('description') or ''}".strip()
    vectors.append(model.encode(text).tolist())
    emb = normalise([sum(col) / len(vectors) for col in zip(*vectors)])

    httpx.patch(f"{SUPABASE_URL}/rest/v1/items", params={"id": f"eq.{item_id}"}, headers=REST,
                json={"embedding": "[" + ",".join(f"{x:.6f}" for x in emb) + "]"}, timeout=15).raise_for_status()

    opposite = "found" if item["kind"] == "lost" else "lost"
    res = httpx.post(f"{SUPABASE_URL}/rest/v1/rpc/match_items", headers=REST, timeout=30,
                     json={"query_embedding": "[" + ",".join(f"{x:.6f}" for x in emb) + "]", "opposite_kind": opposite,
                           "cat": item["category"], "n": TOP_N})
    res.raise_for_status()
    saved = 0
    for m in res.json():
        if m["score"] < THRESHOLD:
            continue
        lost_id, found_id = (item_id, m["id"]) if item["kind"] == "lost" else (m["id"], item_id)
        httpx.post(f"{SUPABASE_URL}/rest/v1/matches", headers={**REST, "Prefer": "resolution=merge-duplicates"},
                   params={"on_conflict": "lost_item_id,found_item_id"},
                   json={"lost_item_id": lost_id, "found_item_id": found_id, "score": m["score"]}, timeout=15).raise_for_status()
        saved += 1
    return {"indexed": True, "matches_saved": saved}
