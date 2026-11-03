-- Lets a signed-in user delete their own Supabase Auth account from the app
-- (Settings -> Delete account), without giving the Twring gateway a service-role key.
--
-- Safety:
--   * no arguments: it can only ever delete the caller, identified by auth.uid() from their JWT;
--   * security definer (runs as the owner, who may delete from auth.users) with a fixed, empty
--     search_path and fully qualified names, so no caller-controlled schema can shadow anything;
--   * EXECUTE revoked from public and anon; granted to authenticated only;
--   * with no signed-in user, auth.uid() is null and the function raises instead of deleting.
-- Deleting the auth.users row cascades to Supabase's own auth tables (identities, sessions,
-- refresh tokens). Twring keeps no rows of its own in this project.

create or replace function public.delete_my_account()
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  caller uuid := auth.uid();
begin
  if caller is null then
    raise exception 'not signed in' using errcode = '42501';
  end if;
  delete from auth.users where id = caller;
end;
$$;

revoke all on function public.delete_my_account() from public;
revoke all on function public.delete_my_account() from anon;
grant execute on function public.delete_my_account() to authenticated;

comment on function public.delete_my_account() is
  'Deletes the calling user''s own auth account. No arguments; authenticated only.';
