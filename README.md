# ◈ Prism Markets

A full-featured Kalshi-style prediction market app built with Supabase + plain HTML/JS/CSS.
Hosted on GitHub Pages — no build step required.

---

## Features

- Magic-link email auth (no password)
- Browse and search prediction markets
- AMM market orders with real price impact
- Limit order book with fill / cancel
- Real-time comments with Supabase Realtime
- Market creation with probability slider
- Portfolio dashboard with P&L
- Market resolution + automatic winner payouts
- $1,000 in play money on signup

---

## Quick Start

### 1. Supabase Project

1. Go to [supabase.com](https://supabase.com) and create a new project.
2. In the Supabase dashboard, go to **SQL Editor** and paste the entire contents of `schema.sql`. Run it.
3. Go to **Authentication → URL Configuration** and add your GitHub Pages URL as a redirect:
   ```
   https://YOUR-USERNAME.github.io/YOUR-REPO-NAME/
   ```
   Also add `http://localhost:PORT/` if you want local dev.

### 2. Configure the App

Open `js/config.js` and replace the two placeholder values:

```js
const SUPABASE_URL      = 'https://YOUR_PROJECT_REF.supabase.co';
const SUPABASE_ANON_KEY = 'YOUR_ANON_KEY_HERE';
```

Find these in: **Supabase Dashboard → Project Settings → API**

### 3. Deploy to GitHub Pages

```bash
# Create a new GitHub repo (e.g. "prism-markets")
git init
git add .
git commit -m "Initial commit"
git remote add origin git@github.com:YOUR-USERNAME/prism-markets.git
git push -u origin main
```

Then in GitHub → **Settings → Pages**:
- Source: `Deploy from a branch`
- Branch: `main` / `root`

Your app will be live at `https://YOUR-USERNAME.github.io/prism-markets/`

### 4. Seed Sample Markets (Optional)

After signing up, grab your user UUID from **Supabase → Authentication → Users**.
Then run in the SQL editor (replace `YOUR-UUID-HERE`):

```sql
insert into public.markets (title, description, category, creator_id, closes_at, yes_price)
values
  ('Will the S&P 500 close above 6,000 by end of Q3 2026?',
   'Resolves YES if the S&P 500 closes at or above 6,000 on the last trading day of September 2026.',
   'Economics', 'YOUR-UUID-HERE', '2026-09-30 20:00:00+00', 0.52),

  ('Will a major AI lab announce AGI before January 2027?',
   'Resolves YES if OpenAI, Anthropic, Google DeepMind, or Meta officially claim AGI has been reached.',
   'Tech', 'YOUR-UUID-HERE', '2026-12-31 23:59:00+00', 0.18),

  ('Will the Kansas City Chiefs win Super Bowl LXI?',
   'Resolves YES if the Kansas City Chiefs win Super Bowl LXI in February 2027.',
   'Sports', 'YOUR-UUID-HERE', '2027-02-08 23:59:00+00', 0.28);
```

---

## How Trading Works

### Market Orders (AMM)
Trades execute instantly against a virtual liquidity pool. Price moves with each trade — the more shares bought, the larger the impact. Starting liquidity is $100; it grows slowly with volume.

**Cost formula:** `avg_price = current_price + (impact / 2)` where `impact = shares / (2 × liquidity)`

### Limit Orders
Place a bid at a specific price. Your funds are reserved immediately. Other users can see your order in the order book and click **Fill** to take the other side. Cancel anytime to reclaim your reserved balance.

### Resolution
Market creators resolve their own markets as YES or NO. All winning-side shares pay out $1 each. Losing shares pay $0. Open limit orders are refunded on resolution.

---

## File Structure

```
/
├── index.html          SPA shell
├── style.css           All styles (True Blue dark theme)
├── schema.sql          Supabase SQL (run once in dashboard)
├── js/
│   ├── config.js       Your Supabase URL + anon key
│   └── app.js          Entire app: router, views, trading logic
└── README.md
```

---

## Local Development

No build step needed. Just serve the files:

```bash
# Python
python3 -m http.server 8080

# Node
npx serve .

# VS Code
# Use the "Live Server" extension
```

Then visit `http://localhost:8080`.

---

## Security Notes

- All trading logic runs in **PostgreSQL RPC functions** (SECURITY DEFINER) — balance checks, atomic trades, and payouts are server-side.
- Row Level Security (RLS) is enabled on all tables.
- The Supabase **anon key** is public by design — it only allows operations permitted by your RLS policies.
- This is a **play-money** app. Do not use real currency.
