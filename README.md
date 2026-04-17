# AI 4K Image Enhancer

Free AI-powered image enhancement using Claude. Visitors get **1 image per day**, no account needed. Rate limiting is enforced server-side by IP via Vercel KV — built into Vercel, no third-party services required.

## Stack

- **Frontend** — vanilla HTML/CSS/JS (`public/index.html`)
- **Backend** — Vercel serverless function (`api/enhance.js`)
- **Rate limiting** — Vercel KV (built-in, free tier)
- **AI** — Anthropic Claude claude-sonnet-4-20250514 (vision)

---

## Deploy in 4 steps

### 1. Push to GitHub

```bash
git init
git add .
git commit -m "initial commit"
gh repo create ai-4k-enhancer --public --push
```

### 2. Import to Vercel

1. Go to vercel.com → New Project → import your repo
2. Add this Environment Variable before deploying:
   - `ANTHROPIC_API_KEY` = your sk-ant-... key
3. Click Deploy

### 3. Enable Vercel KV (one click, built-in)

1. Vercel project → Storage tab → Create Database → KV
2. Name it (e.g. enhancer-kv) → Create → Connect to Project
3. Vercel auto-injects KV_REST_API_URL and KV_REST_API_TOKEN — nothing to copy
4. Redeploy once so the new env vars take effect

### 4. Done

Every visitor gets 1 free enhancement/day by IP, resets midnight UTC.

---

## Cost estimate

- Vercel — free hobby tier (KV included)
- Anthropic — ~$0.003–0.008 per image

At 100 users/day → ~$0.30–0.80/day.

---

## Adjusting the daily limit

In `api/enhance.js` change `if (count > 1)` to `if (count > 2)` etc.
