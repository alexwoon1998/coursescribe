# server.py — CourseScribe licence server
# Handles Gumroad webhooks, key generation, email delivery, and key verification

import os
import uuid
import hmac
import hashlib
import sqlite3
from datetime import datetime

from fastapi import FastAPI, Request, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
from dotenv import load_dotenv
import httpx

load_dotenv()

# ─── Config ──────────────────────────────────────────────────────────────────

GUMROAD_WEBHOOK_SECRET = os.getenv("GUMROAD_WEBHOOK_SECRET")
RESEND_API_KEY          = os.getenv("RESEND_API_KEY")
FROM_EMAIL              = os.getenv("FROM_EMAIL", "noreply@coursescribe.app")
DB_PATH                 = os.getenv("DB_PATH", "licences.db")

# ─── Database ─────────────────────────────────────────────────────────────────

def get_db():
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    return conn

def init_db():
    conn = get_db()
    conn.execute("""
        CREATE TABLE IF NOT EXISTS licences (
            id          INTEGER PRIMARY KEY AUTOINCREMENT,
            key         TEXT UNIQUE NOT NULL,
            email       TEXT NOT NULL,
            order_id    TEXT UNIQUE NOT NULL,
            created_at  TEXT NOT NULL,
            used        INTEGER DEFAULT 0
        )
    """)
    conn.commit()
    conn.close()

def create_licence(email: str, order_id: str) -> str:
    key = "CS-" + str(uuid.uuid4()).upper().replace("-", "")[:20]
    conn = get_db()
    try:
        conn.execute(
            "INSERT INTO licences (key, email, order_id, created_at) VALUES (?, ?, ?, ?)",
            (key, email, order_id, datetime.utcnow().isoformat())
        )
        conn.commit()
    except sqlite3.IntegrityError:
        # Order already processed — look up existing key
        row = conn.execute(
            "SELECT key FROM licences WHERE order_id = ?", (order_id,)
        ).fetchone()
        key = row["key"] if row else None
    finally:
        conn.close()
    return key

def verify_licence_key(key: str) -> bool:
    conn = get_db()
    row = conn.execute(
        "SELECT id FROM licences WHERE key = ?", (key,)
    ).fetchone()
    conn.close()
    return row is not None

# ─── Email ────────────────────────────────────────────────────────────────────

async def send_licence_email(email: str, key: str):
    """Send licence key to buyer via Resend."""
    async with httpx.AsyncClient() as client:
        response = await client.post(
            "https://api.resend.com/emails",
            headers={
                "Authorization": f"Bearer {RESEND_API_KEY}",
                "Content-Type": "application/json"
            },
            json={
                "from": FROM_EMAIL,
                "to": email,
                "subject": "Your CourseScribe Licence Key",
                "html": f"""
                <div style="font-family: sans-serif; max-width: 480px; margin: 0 auto; padding: 32px;">
                    <h2 style="color: #1a56db;">CourseScribe</h2>
                    <p>Thank you for your purchase! Here is your licence key:</p>
                    <div style="background: #f0f4ff; border: 1px solid #c5cde8; border-radius: 8px;
                                padding: 16px; text-align: center; margin: 24px 0;">
                        <code style="font-size: 18px; font-weight: bold; color: #1a56db;
                                     letter-spacing: 2px;">{key}</code>
                    </div>
                    <p><strong>How to activate:</strong></p>
                    <ol>
                        <li>Click the CourseScribe icon in Chrome</li>
                        <li>Click <strong>Unlock Unlimited</strong></li>
                        <li>Paste your key and click <strong>Verify</strong></li>
                    </ol>
                    <p>You now have unlimited transcript extractions.</p>
                    <hr style="border: none; border-top: 1px solid #eee; margin: 24px 0;">
                    <p style="font-size: 12px; color: #999;">
                        Questions? Reply to this email.<br>
                        Source code: <a href="https://github.com/yourusername/coursescribe">GitHub</a>
                    </p>
                </div>
                """
            }
        )
        return response.status_code == 200

# ─── App ──────────────────────────────────────────────────────────────────────

app = FastAPI(title="CourseScribe Licence Server")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],  # Chrome extensions don't have a fixed origin
    allow_methods=["POST"],
    allow_headers=["Content-Type"],
)

@app.on_event("startup")
def startup():
    init_db()
    print("CourseScribe licence server started.")

# ─── Routes ───────────────────────────────────────────────────────────────────

# Health check — Railway uses this to confirm the server is alive
@app.get("/")
def health():
    return { "status": "ok", "service": "CourseScribe Licence Server" }

# Gumroad webhook — fires when someone completes a purchase
@app.post("/webhook/gumroad")
async def gumroad_webhook(request: Request):
    form = await request.form()

    # Verify it's a real sale (not refunded or disputed)
    sale_type = form.get("resource_name")
    if sale_type != "sale":
        return { "status": "ignored" }

    email    = form.get("email")
    order_id = form.get("sale_id")

    if not email or not order_id:
        raise HTTPException(status_code=400, detail="Missing email or order_id")

    # Generate licence key
    key = create_licence(email, order_id)
    if not key:
        raise HTTPException(status_code=500, detail="Failed to create licence")

    # Send key to buyer
    sent = await send_licence_email(email, key)
    if not sent:
        # Key was created — log the failure but don't crash
        # You can manually resend from the database if needed
        print(f"WARNING: Email failed to send for order {order_id} ({email})")

    return { "status": "ok", "email": email }

# Verify licence — called by the Chrome extension
class VerifyRequest(BaseModel):
    key: str

@app.post("/verify")
def verify(body: VerifyRequest):
    is_valid = verify_licence_key(body.key.strip())
    return { "valid": is_valid }

# ─── Manual key generation (admin use only) ───────────────────────────────────
# Use this to manually issue a key — call it from your terminal with curl:
# curl -X POST https://your-app.up.railway.app/admin/generate \
#      -H "Content-Type: application/json" \
#      -d '{"email": "someone@example.com", "order_id": "manual-001", "secret": "YOUR_ADMIN_SECRET"}'

class AdminGenerateRequest(BaseModel):
    email: str
    order_id: str
    secret: str

@app.post("/admin/generate")
def admin_generate(body: AdminGenerateRequest):
    admin_secret = os.getenv("ADMIN_SECRET")
    if not admin_secret or body.secret != admin_secret:
        raise HTTPException(status_code=403, detail="Forbidden")
    key = create_licence(body.email, body.order_id)
    return { "key": key, "email": body.email }
