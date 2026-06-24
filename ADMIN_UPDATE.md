# Prism Markets - Update Instructions

## What's New

1. **Admin Dashboard** with user and market analytics
2. **Reopen Markets** - admins can extend a closed market's closing time (yes_price is locked, can't change)
3. **Mobile Hamburger Menu** - responsive nav that collapses on mobile
4. **Hamburger Nav with Mobile Menu** - full navigation in a slide-out overlay on small screens

---

## Installation

### Step 1: Update Supabase Schema

Go to **Supabase Dashboard → SQL Editor** and run this to add the reopen function:

```sql
-- ============================================================
-- RPC: reopen_market  (admin only — extend closes_at)
-- ============================================================
create or replace function public.reopen_market(
  p_admin_id  uuid,
  p_market_id uuid,
  p_new_closes_at timestamptz
)
returns json
language plpgsql security definer
set search_path = public
as $$
declare
  v_is_admin  boolean;
  v_market    public.markets;
begin
  if (select auth.uid()) != p_admin_id then return json_build_object('error','Unauthorized'); end if;
  
  select is_admin into v_is_admin from public.profiles where id = p_admin_id;
  if not v_is_admin then return json_build_object('error','Only admins can reopen markets'); end if;

  select * into v_market from public.markets where id = p_market_id for update;
  if not found then return json_build_object('error','Market not found'); end if;
  if v_market.resolved_at is not null then return json_build_object('error','Cannot reopen resolved market'); end if;
  if p_new_closes_at <= now() then return json_build_object('error','New close time must be in the future'); end if;

  update public.markets
  set closes_at = p_new_closes_at
  where id = p_market_id;

  return json_build_object('success', true, 'new_closes_at', p_new_closes_at);
end;
$$;

grant execute on function public.reopen_market to authenticated;
```

If you already have the old schema.sql, look for this line at the end:
```sql
grant execute on function public.resolve_market       to authenticated;
```

Replace it with the code above (the reopen_market function + the grant).

### Step 2: Update Your App Files

Replace your existing files with the new ones from `prism-markets.zip`. Key changes:

- `js/app.js`: Added `renderAdmin()` view, hamburger menu logic, admin route
- `style.css`: Added hamburger styles (`.nav-hamburger`, `.nav-mobile-menu`)
- `schema.sql`: Added `reopen_market()` RPC function

### Step 3: Make Yourself Admin

In Supabase SQL Editor, run (replace with your actual user ID):

```sql
update public.profiles set is_admin = true where id = 'YOUR-USER-ID-HERE';
```

Get your user ID from **Supabase → Authentication → Users**.

### Step 4: Push to GitHub

```bash
git add .
git commit -m "Add admin dashboard, reopen market, hamburger nav"
git push
```

---

## Features

### Admin Dashboard (`#/admin`)

Access via the navbar link "Admin" (only visible if you're an admin).

Shows:
- **Stats**: Total users, platform balance, markets, volume
- **Users table**: Last 100 users with balance, positions, open orders, join date
- **Markets table**: Last 50 markets with a **Reopen** button for closed markets

### Reopen a Market

Click **Reopen** on any closed (but unresolved) market. Set a new closing time in the future. The market's yes_price is **locked** — you can't change the probability, only extend the deadline.

### Mobile Navigation

On screens < 600px wide:
- Navbar hides the links and balance
- A **hamburger icon** (☰) appears on the right
- Click it to reveal a slide-out menu with Markets, Create, Portfolio, Admin (if admin), Profile, Sign Out
- Menu closes automatically when you navigate

---

## Notes

- Admins can **reopen closed markets but cannot change the yes_price** — this protects traders who've already bet
- Admins can **see all user balances and open orders** on the dashboard
- Only profiles with `is_admin = true` can access `/admin` route
- Mobile nav uses a hamburger pattern with slide animation
