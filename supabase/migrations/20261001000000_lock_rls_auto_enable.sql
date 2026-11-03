-- rls_auto_enable() backs the ensure_rls event trigger (turns on RLS for new public tables).
-- Event triggers run it as the owner regardless of EXECUTE grants, so API roles never need it.
-- Before this, anon and authenticated could call it through /rest/v1/rpc (Supabase advisor 0028/0029).
revoke all on function public.rls_auto_enable() from public;
revoke all on function public.rls_auto_enable() from anon;
revoke all on function public.rls_auto_enable() from authenticated;
