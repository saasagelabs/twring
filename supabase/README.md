# Supabase (sign-in project)

Twring uses Supabase only for sign-in (ADR-021). The gateway holds no Supabase secret; the phone
uses the publishable key. SQL the project needs lives in `migrations/`, applied by the owner.

## Apply a migration

Either:

- **Dashboard:** Supabase → the Twring project → SQL Editor → paste the migration file → Run; or
- **CLI:** `supabase link --project-ref <ref>` once, then `supabase db push`.

Apply to staging first, then production. Migrations are idempotent (`create or replace`).

## `20260930000000_delete_my_account.sql`

Adds `public.delete_my_account()`, which the app calls (`supabase.rpc('delete_my_account')`)
after `DELETE /v1/me/data` to delete the signed-in user's own sign-in account. It takes no
arguments and deletes only `auth.uid()`.

Check it after applying (SQL Editor):

```sql
-- Expect: prosecdef = true, proconfig = {search_path=""}, no arguments.
select prosecdef, proconfig, pg_get_function_arguments(oid) as args
from pg_proc where oid = 'public.delete_my_account()'::regprocedure;

-- Expect: authenticated = true, anon = false.
select has_function_privilege('authenticated', 'public.delete_my_account()', 'execute') as authenticated,
       has_function_privilege('anon', 'public.delete_my_account()', 'execute') as anon;
```

Until it is applied, "Delete account" deletes the data, then reports that the account itself
could not be deleted and offers a retry (the email route on `/account-deletion` still works).
