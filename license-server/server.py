# server.py — CourseScribe licence server
# Handles Gumroad webhooks, key generation, email delivery, and key verification

import os
import uuid
import sqlite3
from datetime import datetime

from fastapi import FastAPI, Request, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
from dotenv import load_dotenv
import httpx

load_dotenv()

# ─── Config ──────────────────────────────────────────────────────────────────

RESEND_API_KEY    = os.getenv("RESEND_API_KEY")
FROM_EMAIL        = os.getenv("FROM_EMAIL", "noreply@alexhzwoon.cc")
DB_PATH           = os.getenv("DB_PATH", "licences.db")
GUMROAD_SELLER_ID = os.getenv("GUMROAD_SELLER_ID")

# ─── Database ─────────────────────────────────────────────────────────────────

def get_db():
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    return conn

def init_db():
    conn = get_db()
    # Create table if it doesn't exist
    conn.execute("""
        CREATE TABLE IF NOT EXISTS licences (
            id          INTEGER PRIMARY KEY AUTOINCREMENT,
            key         TEXT UNIQUE NOT NULL,
            email       TEXT NOT NULL,
            order_id    TEXT UNIQUE NOT NULL,
            created_at  TEXT NOT NULL,
            active      INTEGER DEFAULT 1
        )
    """)
    # Add active column if upgrading from old schema
    try:
        conn.execute("ALTER TABLE licences ADD COLUMN active INTEGER DEFAULT 1")
    except:
        pass  # Column already exists
    conn.commit()
    conn.close()

def create_licence(email: str, order_id: str) -> str:
    key = "CS-" + str(uuid.uuid4()).upper().replace("-", "")[:20]
    conn = get_db()
    try:
        conn.execute(
            "INSERT INTO licences (key, email, order_id, created_at, active) VALUES (?, ?, ?, ?, 1)",
            (key, email, order_id, datetime.utcnow().isoformat())
        )
        conn.commit()
    except sqlite3.IntegrityError:
        row = conn.execute(
            "SELECT key FROM licences WHERE order_id = ?", (order_id,)
        ).fetchone()
        key = row["key"] if row else None
    finally:
        conn.close()
    return key

def verify_licence_key(key: str) -> bool:
    conn = get_db()
    # Key must exist AND be active
    row = conn.execute(
        "SELECT id FROM licences WHERE key = ? AND active = 1", (key,)
    ).fetchone()
    conn.close()
    return row is not None

def deactivate_licence_key(key: str) -> bool:
    conn = get_db()
    cursor = conn.execute(
        "UPDATE licences SET active = 0 WHERE key = ?", (key,)
    )
    conn.commit()
    affected = cursor.rowcount
    conn.close()
    return affected > 0

def reactivate_licence_key(key: str) -> bool:
    conn = get_db()
    cursor = conn.execute(
        "UPDATE licences SET active = 1 WHERE key = ?", (key,)
    )
    conn.commit()
    affected = cursor.rowcount
    conn.close()
    return affected > 0

# ─── Email ────────────────────────────────────────────────────────────────────

async def send_licence_email(email: str, key: str):
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
                        Source code: <a href="https://github.com/alexwoon1998/coursescribe">GitHub</a>
                    </p>
                </div>
                """
            }
        )
        return response.status_code == 200

async def send_refund_email(email: str):
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
                "subject": "Your CourseScribe Refund",
                "html": """
                <div style="font-family: sans-serif; max-width: 480px; margin: 0 auto; padding: 32px;">
                    <h2 style="color: #1a56db;">CourseScribe</h2>
                    <p>Your refund has been processed and your licence key has been deactivated.</p>
                    <p>If you believe this was a mistake or would like to try again,
                    please reply to this email and we'll be happy to help.</p>
                    <hr style="border: none; border-top: 1px solid #eee; margin: 24px 0;">
                    <p style="font-size: 12px; color: #999;">CourseScribe Support</p>
                </div>
                """
            }
        )
        return response.status_code == 200

# ─── App ──────────────────────────────────────────────────────────────────────

app = FastAPI(title="CourseScribe Licence Server")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["POST", "GET"],
    allow_headers=["Content-Type"],
)

@app.on_event("startup")
def startup():
    init_db()
    print("CourseScribe licence server started.")

# ─── Routes ───────────────────────────────────────────────────────────────────

@app.get("/")
def health():
    return { "status": "ok", "service": "CourseScribe Licence Server" }

# Gumroad webhook — fires on purchase
@app.post("/webhook/gumroad")
async def gumroad_webhook(request: Request):
    form = await request.form()

    # Verify the request is from our Gumroad account
    seller_id = form.get("seller_id")
    if not GUMROAD_SELLER_ID or seller_id != GUMROAD_SELLER_ID:
        raise HTTPException(status_code=401, detail="Unauthorized webhook request")

    sale_type = form.get("resource_name")
    if sale_type != "sale":
        return { "status": "ignored" }

    email    = form.get("email")
    order_id = form.get("sale_id")

    if not email or not order_id:
        raise HTTPException(status_code=400, detail="Missing email or order_id")

    key = create_licence(email, order_id)
    if not key:
        raise HTTPException(status_code=500, detail="Failed to create licence")

    sent = await send_licence_email(email, key)
    if not sent:
        print(f"WARNING: Email failed to send for order {order_id} ({email})")

    return { "status": "ok", "email": email }

# Verify licence — called by Chrome extension
class VerifyRequest(BaseModel):
    key: str

@app.post("/verify")
def verify(body: VerifyRequest):
    is_valid = verify_licence_key(body.key.strip())
    return { "valid": is_valid }

# ─── Admin endpoints ──────────────────────────────────────────────────────────

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

class AdminKeyRequest(BaseModel):
    key: str
    secret: str

@app.post("/admin/deactivate")
async def admin_deactivate(body: AdminKeyRequest):
    admin_secret = os.getenv("ADMIN_SECRET")
    if not admin_secret or body.secret != admin_secret:
        raise HTTPException(status_code=403, detail="Forbidden")
    # Look up email before deactivating so we can notify them
    conn = get_db()
    row = conn.execute(
        "SELECT email FROM licences WHERE key = ?", (body.key,)
    ).fetchone()
    conn.close()
    if not row:
        raise HTTPException(status_code=404, detail="Key not found")
    success = deactivate_licence_key(body.key)
    if success:
        # Send refund notification email
        await send_refund_email(row["email"])
        return { "status": "deactivated", "key": body.key, "email": row["email"] }
    raise HTTPException(status_code=500, detail="Failed to deactivate key")

@app.post("/admin/reactivate")
def admin_reactivate(body: AdminKeyRequest):
    admin_secret = os.getenv("ADMIN_SECRET")
    if not admin_secret or body.secret != admin_secret:
        raise HTTPException(status_code=403, detail="Forbidden")
    success = reactivate_licence_key(body.key)
    if success:
        return { "status": "reactivated", "key": body.key }
    raise HTTPException(status_code=404, detail="Key not found")
