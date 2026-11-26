---
name: twring-accounts-and-rings
description: Account traps in Twring sign-in, sign-out and rings. Use when changing sign-in or sign-out code in the app or in web pages that use Supabase auth (such as the consent page), or when a ring or call to a phone fails.
---

# Accounts and rings

- **Supabase `signOut()` is global by default:** it ends every session of that account, the phone app's included. Web pages (the consent page) sign out with `{ scope: 'local' }`.
- **Rings go to the account, not the device in your hand.** An AI app connected as one account can't ring a phone signed in to another (`no_ring_phone`). When a ring fails, check which account consented before suspecting the server.
