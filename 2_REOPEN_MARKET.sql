-- ============================================================
-- REOPEN MARKET SQL
-- Copy & paste this into Supabase SQL Editor
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
