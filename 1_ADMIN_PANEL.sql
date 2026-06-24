-- ============================================================
-- ADMIN PANEL SQL
-- Copy & paste this into Supabase SQL Editor
-- ============================================================

create or replace function public.get_admin_stats(p_user_id uuid)
returns json
language plpgsql security definer
set search_path = public
as $$
declare
  v_is_admin boolean;
  v_stats    json;
begin
  select is_admin into v_is_admin from public.profiles where id = p_user_id;
  if not v_is_admin then
    return json_build_object('error', 'Unauthorized');
  end if;

  select json_build_object(
    'total_users',      (select count(*) from profiles),
    'total_balance',    (select coalesce(sum(balance), 0) from profiles),
    'total_markets',    (select count(*) from markets),
    'resolved_markets', (select count(*) from markets where resolved_at is not null),
    'total_volume',     (select coalesce(sum(volume), 0) from markets),
    'users',            (
      select json_agg(row_to_json(u.*)) from (
        select id, username, email, balance, created_at,
               (select count(*) from positions where user_id = profiles.id and (yes_shares > 0 or no_shares > 0)) as open_positions,
               (select count(*) from orders where user_id = profiles.id and status in ('open','partial')) as open_orders
        from profiles
        order by created_at desc
        limit 100
      ) u
    ),
    'markets', (
      select json_agg(row_to_json(m.*)) from (
        select id, title, category, creator_id, yes_price, volume, 
               (select username from profiles where id = markets.creator_id) as creator,
               created_at, closes_at, resolved_at, resolution,
               (select count(*) from positions where market_id = markets.id) as traders
        from markets
        order by created_at desc
        limit 50
      ) m
    )
  ) into v_stats;

  return v_stats;
end;
$$;

grant execute on function public.get_admin_stats to authenticated;
