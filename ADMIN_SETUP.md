# Admin Setup - Four Steps

## Step 1: Run Admin Panel SQL

Go to **Supabase Dashboard → SQL Editor**

Copy & paste the entire contents of **`1_ADMIN_PANEL.sql`** and click RUN.

This creates the `get_admin_stats()` function that powers the dashboard.

---

## Step 2: Run Reopen Market SQL

Copy & paste the entire contents of **`2_REOPEN_MARKET.sql`** and click RUN.

This creates the `reopen_market()` function so admins can extend closed markets.

---

## Step 3: Make Yourself Admin

In the same SQL Editor, run this (replace with your user UUID):

```sql
update public.profiles set is_admin = true where id = 'YOUR-USER-ID-HERE';
```

Get your user ID from **Supabase → Authentication → Users** tab.

---

## Step 4: Deploy the New App

Replace your repo files with `prism-markets.zip` contents, then:

```bash
git add .
git commit -m "Add admin dashboard, reopen market, mobile hamburger nav"
git push
```

You'll see an "Admin" link in the navbar.
