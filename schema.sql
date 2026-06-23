-- ============================================================
-- PRISM MARKETS - Supabase Schema
-- Run this in your Supabase SQL editor (Dashboard > SQL Editor)
-- ============================================================

-- PROFILES
create table if not exists public.profiles (
  id            uuid primary key references auth.users(id) on delete cascade,
  username      text unique not null,
  bio           text,
  balance       numeric(14,4) not null default 1000.0,
  created_at    timestamptz not null default now()
);

-- MARKETS
create table if not exists public.markets (
  id            uuid primary key default gen_random_uuid(),
  title         text not null,
  description   text,
  category      text not null default 'General',
  creator_id    uuid not null references public.profiles(id),
  closes_at     timestamptz not null,
  resolved_at   timestamptz,
  resolution    text check (resolution in ('yes','no')),
  yes_price     numeric(8,6) not null default 0.5 check (yes_price between 0 and 1),
  volume        numeric(14,4) not null default 0,
  liquidity     numeric(14,4) not null default 100,
  created_at    timestamptz not null default now()
);

-- ORDERS  (limit orders shown in order book + market order history)
create table if not exists public.orders (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null references public.profiles(id),
  market_id     uuid not null references public.markets(id) on delete cascade,
  side          text not null check (side in ('yes','no')),
  type          text not null check (type in ('market','limit')),
  price         numeric(8,6) not null check (price > 0 and price < 1),
  quantity      numeric(14,4) not null check (quantity > 0),
  filled        numeric(14,4) not null default 0,
  status        text not null default 'open' check (status in ('open','partial','filled','cancelled')),
  created_at    timestamptz not null default now()
);

-- POSITIONS  (shares held per user per market)
create table if not exists public.positions (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null references public.profiles(id),
  market_id     uuid not null references public.markets(id) on delete cascade,
  yes_shares    numeric(14,4) not null default 0,
  no_shares     numeric(14,4) not null default 0,
  updated_at    timestamptz not null default now(),
  unique(user_id, market_id)
);

-- COMMENTS
create table if not exists public.comments (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null references public.profiles(id),
  market_id     uuid not null references public.markets(id) on delete cascade,
  content       text not null check (length(content) > 0 and length(content) <= 2000),
  created_at    timestamptz not null default now()
);

-- ============================================================
-- ROW LEVEL SECURITY
-- ============================================================

alter table public.profiles  enable row level security;
alter table public.markets   enable row level security;
alter table public.orders    enable row level security;
alter table public.positions enable row level security;
alter table public.comments  enable row level security;

-- profiles
create policy "profiles_select" on public.profiles for select using (true);
create policy "profiles_insert" on public.profiles for insert with check (auth.uid() = id);
create policy "profiles_update" on public.profiles for update using (auth.uid() = id);

-- markets
create policy "markets_select" on public.markets for select using (true);
create policy "markets_insert" on public.markets for insert with check (auth.uid() = creator_id);
create policy "markets_update" on public.markets for update using (auth.uid() = creator_id);

-- orders (all reads open; writes via RPC only)
create policy "orders_select" on public.orders for select using (true);
create policy "orders_insert" on public.orders for insert with check (auth.uid() = user_id);
create policy "orders_update" on public.orders for update using (auth.uid() = user_id);

-- positions
create policy "positions_select" on public.positions for select using (true);
create policy "positions_all"    on public.positions for all   using (auth.uid() = user_id);

-- comments
create policy "comments_select" on public.comments for select using (true);
create policy "comments_insert" on public.comments for insert with check (auth.uid() = user_id);
create policy "comments_delete" on public.comments for delete using (auth.uid() = user_id);

-- ============================================================
-- RPC: ensure_profile
-- Creates a profile on first login, returns it either way.
-- ============================================================
create or replace function public.ensure_profile(p_user_id uuid, p_email text)
returns public.profiles
language plpgsql security definer
set search_path = public
as $$
declare
  v_profile public.profiles;
  v_username text;
begin
  select * into v_profile from public.profiles where id = p_user_id;
  if found then return v_profile; end if;

  v_username := regexp_replace(split_part(p_email, '@', 1), '[^a-zA-Z0-9_]', '_', 'g')
                || '_' || substring(p_user_id::text, 1, 4);

  insert into public.profiles (id, username, balance)
  values (p_user_id, v_username, 1000.0)
  returning * into v_profile;

  return v_profile;
end;
$$;

-- ============================================================
-- RPC: execute_market_order  (AMM trade — fully atomic)
-- ============================================================
create or replace function public.execute_market_order(
  p_user_id  uuid,
  p_market_id uuid,
  p_side     text,
  p_shares   numeric
)
returns json
language plpgsql security definer
set search_path = public
as $$
declare
  v_market       public.markets;
  v_balance      numeric;
  v_liquidity    numeric;
  v_cur_price    numeric;
  v_impact       numeric;
  v_avg_price    numeric;
  v_cost         numeric;
  v_new_price    numeric;
begin
  if (select auth.uid()) != p_user_id then
    return json_build_object('error', 'Unauthorized');
  end if;
  if p_shares <= 0 then
    return json_build_object('error', 'Shares must be positive');
  end if;

  select * into v_market from public.markets where id = p_market_id for update;
  if not found       then return json_build_object('error', 'Market not found'); end if;
  if v_market.resolved_at is not null then return json_build_object('error', 'Market has been resolved'); end if;
  if v_market.closes_at <= now()      then return json_build_object('error', 'Market is closed'); end if;

  -- AMM pricing (linear impact model)
  v_liquidity := greatest(v_market.liquidity, 10);
  v_cur_price := case when p_side = 'yes' then v_market.yes_price else 1.0 - v_market.yes_price end;
  v_impact    := p_shares / (2.0 * v_liquidity);
  v_avg_price := least(0.99, greatest(0.01, v_cur_price + v_impact / 2.0));
  v_cost      := v_avg_price * p_shares;

  if p_side = 'yes' then
    v_new_price := least(0.99, greatest(0.01, v_market.yes_price + v_impact));
  else
    v_new_price := least(0.99, greatest(0.01, v_market.yes_price - v_impact));
  end if;

  -- Balance check
  select balance into v_balance from public.profiles where id = p_user_id for update;
  if v_balance < v_cost then
    return json_build_object(
      'error', 'Insufficient balance — need $' || round(v_cost::numeric, 2) ||
               ', have $' || round(v_balance::numeric, 2)
    );
  end if;

  -- Debit user
  update public.profiles
  set balance = balance - v_cost
  where id = p_user_id;

  -- Update market (grow liquidity slowly with volume)
  update public.markets
  set yes_price = v_new_price,
      volume    = volume + v_cost,
      liquidity = least(liquidity + v_cost * 0.05, 50000)
  where id = p_market_id;

  -- Upsert position
  insert into public.positions (user_id, market_id, yes_shares, no_shares)
  values (
    p_user_id, p_market_id,
    case when p_side = 'yes' then p_shares else 0 end,
    case when p_side = 'no'  then p_shares else 0 end
  )
  on conflict (user_id, market_id) do update set
    yes_shares = positions.yes_shares + case when p_side = 'yes' then p_shares else 0 end,
    no_shares  = positions.no_shares  + case when p_side = 'no'  then p_shares else 0 end,
    updated_at = now();

  -- Record as filled market order
  insert into public.orders (user_id, market_id, side, type, price, quantity, filled, status)
  values (p_user_id, p_market_id, p_side, 'market', v_avg_price, p_shares, p_shares, 'filled');

  return json_build_object(
    'success',   true,
    'cost',      round(v_cost::numeric, 4),
    'avg_price', round(v_avg_price::numeric, 4),
    'new_price', round(v_new_price::numeric, 4),
    'shares',    p_shares
  );
end;
$$;

-- ============================================================
-- RPC: place_limit_order  (reserves funds, enters order book)
-- ============================================================
create or replace function public.place_limit_order(
  p_user_id   uuid,
  p_market_id uuid,
  p_side      text,
  p_price     numeric,
  p_quantity  numeric
)
returns json
language plpgsql security definer
set search_path = public
as $$
declare
  v_market  public.markets;
  v_balance numeric;
  v_cost    numeric;
  v_oid     uuid;
begin
  if (select auth.uid()) != p_user_id then return json_build_object('error','Unauthorized'); end if;
  if p_price <= 0 or p_price >= 1 then return json_build_object('error','Price must be between 0.01 and 0.99'); end if;
  if p_quantity <= 0 then return json_build_object('error','Quantity must be positive'); end if;

  select * into v_market from public.markets where id = p_market_id;
  if not found                       then return json_build_object('error','Market not found'); end if;
  if v_market.resolved_at is not null then return json_build_object('error','Market resolved'); end if;
  if v_market.closes_at <= now()      then return json_build_object('error','Market closed'); end if;

  v_cost := p_price * p_quantity;

  select balance into v_balance from public.profiles where id = p_user_id for update;
  if v_balance < v_cost then
    return json_build_object('error','Insufficient balance — need $' || round(v_cost::numeric,2));
  end if;

  -- Reserve funds upfront
  update public.profiles set balance = balance - v_cost where id = p_user_id;

  insert into public.orders (user_id, market_id, side, type, price, quantity, filled, status)
  values (p_user_id, p_market_id, p_side, 'limit', p_price, p_quantity, 0, 'open')
  returning id into v_oid;

  return json_build_object('success', true, 'order_id', v_oid, 'reserved', round(v_cost::numeric,4));
end;
$$;

-- ============================================================
-- RPC: fill_limit_order  (counterparty takes the other side)
-- ============================================================
create or replace function public.fill_limit_order(
  p_filler_id uuid,
  p_order_id  uuid,
  p_quantity  numeric
)
returns json
language plpgsql security definer
set search_path = public
as $$
declare
  v_order      public.orders;
  v_market     public.markets;
  v_bal        numeric;
  v_fill_side  text;
  v_fill_price numeric;
  v_fill_cost  numeric;
  v_available  numeric;
begin
  if (select auth.uid()) != p_filler_id then return json_build_object('error','Unauthorized'); end if;

  select * into v_order from public.orders where id = p_order_id for update;
  if not found then return json_build_object('error','Order not found'); end if;
  if v_order.status not in ('open','partial') then return json_build_object('error','Order not fillable'); end if;
  if v_order.user_id = p_filler_id then return json_build_object('error','Cannot fill your own order'); end if;

  select * into v_market from public.markets where id = v_order.market_id;
  if v_market.resolved_at is not null then return json_build_object('error','Market resolved'); end if;

  v_available := v_order.quantity - v_order.filled;
  if p_quantity > v_available then p_quantity := v_available; end if;
  if p_quantity <= 0 then return json_build_object('error','Nothing to fill'); end if;

  -- Filler takes opposite side at complementary price
  v_fill_side  := case when v_order.side = 'yes' then 'no' else 'yes' end;
  v_fill_price := 1.0 - v_order.price;
  v_fill_cost  := v_fill_price * p_quantity;

  select balance into v_bal from public.profiles where id = p_filler_id for update;
  if v_bal < v_fill_cost then
    return json_build_object('error','Insufficient balance — need $' || round(v_fill_cost::numeric,2));
  end if;

  -- Debit filler
  update public.profiles set balance = balance - v_fill_cost where id = p_filler_id;

  -- Update order
  update public.orders
  set filled = filled + p_quantity,
      status = case when filled + p_quantity >= quantity then 'filled' else 'partial' end
  where id = p_order_id;

  -- Give shares to original order placer
  insert into public.positions (user_id, market_id, yes_shares, no_shares)
  values (v_order.user_id, v_order.market_id,
    case when v_order.side = 'yes' then p_quantity else 0 end,
    case when v_order.side = 'no'  then p_quantity else 0 end)
  on conflict (user_id, market_id) do update set
    yes_shares = positions.yes_shares + case when v_order.side = 'yes' then p_quantity else 0 end,
    no_shares  = positions.no_shares  + case when v_order.side = 'no'  then p_quantity else 0 end,
    updated_at = now();

  -- Give opposite shares to filler
  insert into public.positions (user_id, market_id, yes_shares, no_shares)
  values (p_filler_id, v_order.market_id,
    case when v_fill_side = 'yes' then p_quantity else 0 end,
    case when v_fill_side = 'no'  then p_quantity else 0 end)
  on conflict (user_id, market_id) do update set
    yes_shares = positions.yes_shares + case when v_fill_side = 'yes' then p_quantity else 0 end,
    no_shares  = positions.no_shares  + case when v_fill_side = 'no'  then p_quantity else 0 end,
    updated_at = now();

  -- Record filler's order
  insert into public.orders (user_id, market_id, side, type, price, quantity, filled, status)
  values (p_filler_id, v_order.market_id, v_fill_side, 'limit', v_fill_price, p_quantity, p_quantity, 'filled');

  return json_build_object(
    'success', true,
    'filled',  p_quantity,
    'cost',    round(v_fill_cost::numeric,4)
  );
end;
$$;

-- ============================================================
-- RPC: cancel_limit_order  (refunds reserved funds)
-- ============================================================
create or replace function public.cancel_limit_order(
  p_user_id  uuid,
  p_order_id uuid
)
returns json
language plpgsql security definer
set search_path = public
as $$
declare
  v_order  public.orders;
  v_refund numeric;
begin
  if (select auth.uid()) != p_user_id then return json_build_object('error','Unauthorized'); end if;

  select * into v_order from public.orders where id = p_order_id for update;
  if not found then return json_build_object('error','Order not found'); end if;
  if v_order.user_id != p_user_id then return json_build_object('error','Not your order'); end if;
  if v_order.status not in ('open','partial') then return json_build_object('error','Order cannot be cancelled'); end if;

  v_refund := v_order.price * (v_order.quantity - v_order.filled);

  update public.orders   set status  = 'cancelled' where id = p_order_id;
  update public.profiles set balance = balance + v_refund where id = p_user_id;

  return json_build_object('success', true, 'refunded', round(v_refund::numeric,4));
end;
$$;

-- ============================================================
-- RPC: resolve_market  (pays winners, cancels open orders)
-- ============================================================
create or replace function public.resolve_market(
  p_resolver_id uuid,
  p_market_id   uuid,
  p_resolution  text
)
returns json
language plpgsql security definer
set search_path = public
as $$
declare
  v_market      public.markets;
  v_order_row   record;
  v_pos_row     record;
  v_refund      numeric;
  v_payout      numeric;
  v_total       numeric := 0;
begin
  if (select auth.uid()) != p_resolver_id then return json_build_object('error','Unauthorized'); end if;
  if p_resolution not in ('yes','no') then return json_build_object('error','Resolution must be yes or no'); end if;

  select * into v_market from public.markets where id = p_market_id for update;
  if not found then return json_build_object('error','Market not found'); end if;
  if v_market.creator_id    != p_resolver_id then return json_build_object('error','Only the creator can resolve'); end if;
  if v_market.resolved_at is not null         then return json_build_object('error','Already resolved'); end if;

  -- Resolve the market
  update public.markets
  set resolved_at = now(), resolution = p_resolution
  where id = p_market_id;

  -- Refund all open limit orders
  for v_order_row in
    select * from public.orders
    where market_id = p_market_id and status in ('open','partial')
  loop
    v_refund := v_order_row.price * (v_order_row.quantity - v_order_row.filled);
    if v_refund > 0 then
      update public.profiles set balance = balance + v_refund where id = v_order_row.user_id;
    end if;
    update public.orders set status = 'cancelled' where id = v_order_row.id;
  end loop;

  -- Pay out winning positions
  for v_pos_row in select * from public.positions where market_id = p_market_id loop
    v_payout := case
      when p_resolution = 'yes' then v_pos_row.yes_shares
      else v_pos_row.no_shares
    end;
    if v_payout > 0 then
      update public.profiles set balance = balance + v_payout where id = v_pos_row.user_id;
      v_total := v_total + v_payout;
    end if;
  end loop;

  return json_build_object('success', true, 'total_payout', round(v_total::numeric,4));
end;
$$;

-- ============================================================
-- GRANTS
-- ============================================================
grant execute on function public.ensure_profile       to authenticated;
grant execute on function public.execute_market_order to authenticated;
grant execute on function public.place_limit_order    to authenticated;
grant execute on function public.fill_limit_order     to authenticated;
grant execute on function public.cancel_limit_order   to authenticated;
grant execute on function public.resolve_market       to authenticated;

-- ============================================================
-- REALTIME  (enable for comments + market price updates)
-- ============================================================
alter publication supabase_realtime add table public.comments;
alter publication supabase_realtime add table public.markets;
alter publication supabase_realtime add table public.orders;

-- ============================================================
-- OPTIONAL: seed a few sample markets (replace creator_id!)
-- ============================================================
-- After signing up and copying your user UUID from the Auth tab:
--
-- insert into public.markets (title, description, category, creator_id, closes_at, yes_price)
-- values
--   ('Will the S&P 500 close above 6,000 by end of Q3 2026?',
--    'Resolves YES if the S&P 500 index closes at or above 6,000 on the last trading day of September 2026.',
--    'Economics', 'YOUR-UUID-HERE', '2026-09-30 20:00:00+00', 0.52),
--   ('Will a major AI lab announce AGI before 2027?',
--    'Resolves YES if OpenAI, Anthropic, Google DeepMind, or Meta officially claim AGI has been reached.',
--    'Tech', 'YOUR-UUID-HERE', '2026-12-31 23:59:00+00', 0.18),
--   ('Will it snow in Tulsa, OK on Christmas Day 2026?',
--    'Resolves YES if measurable snow (>0.1 inches) is recorded at Tulsa International Airport on Dec 25.',
--    'Culture', 'YOUR-UUID-HERE', '2026-12-26 06:00:00+00', 0.23);
