---
name: saved-logins
title: Saved logins
description: Use saved logins without putting a password in context.
version: 1.0.0
author: Ravnir
license: MIT
---

# Saved Logins

Ravnir fills passwords for you. You never see them, and that is the design, not a limitation: a
secret in your context is a secret in the transcript, the prompt cache, the compaction summary and
the backup. This skill is how to get signed in without ever holding the password.

## When to Use

- A site needs a login and the owner has one saved
- You are about to ask the owner for a password (you never should — read this instead)
- A saved login fails, or the site asks for a second factor
- The owner asks you to log in somewhere "with the usual"

## Prerequisites

- A saved login for that site, linked to you. `list_saved_logins` shows yours; if the list is
  empty, the owner has not linked one to this agent yet.
- The browser runtime. `browser_saved_login` fills the page in your own Chromium profile, where
  the server reads the secret directly from the encrypted store.

## Procedure

1. **Look before you ask.** Call `list_saved_logins`. It returns the sites linked to this agent,
   with the username and the label, never the password.
2. **Open the sign-in page in your browser**, not a fetch. `browser_open` on the site's login URL.
   The page must be the real form: a bot wall or a challenge means take-over, not a password.
3. **Fill it with `browser_saved_login`**, passing the site and, when you know it, the username.
   The server fetches the secret, types it into the page, and returns the result of the attempt.
4. **Continue the login yourself** if the site needs a button that does not submit on Enter:
   `browser_click` the sign-in button, then `browser_read` to confirm you are through.
5. **If it worked**, go on with the task. Say "signed in as <username>" in the reply if it matters,
   never the password.
6. **If the login is missing**, call `ask_user` once (about: access) saying which site and why.
   The owner can sign in on your own screen with take-over, or link the item in the Logins tab of
your agent view, and your
   turn continues from there.

### Second factors

A code by SMS, an authenticator app, a passkey: you cannot complete these. Call
`ask_user_to_take_over` with the page address and the reason. The owner finishes the sign-in on
your screen, presses Done, and you keep working from the page they leave you on. Do not ask for the
code in chat and do not try to read it from the owner's mail unless they explicitly tell you to.

### 1Password items

When the owner links a 1Password item, the server reads it with the service account and types the
password at fill time — same rule, you never see it. Two things are worth knowing:

- A linked item that answers "a vault query must be provided" was linked without its vault. Tell
  the owner to open the Logins tab in your agent view and link it again; that is a server-side fix,
  not something you retry.
- An item that is "signed out" needs the owner to sign the CLI in again. Say so once.

## Pitfalls

- **Never** ask for a password in chat, and never repeat one the owner pastes at you. If they paste
  one, tell them you did not need it and that it is now in the transcript.
- **Never** read `.env` files, cookie stores, browser profile databases or keychain dumps. That is
  exactly the material this feature exists to keep out of your context.
- **Do not loop on a failing fill.** Two attempts, then take-over or `ask_user`.
- **Do not invent credentials** or try a default admin login. That is not debugging.
- **A signed-in session is per agent.** Your browser profile is yours; another agent's cookies are
  not in it, and asking the owner twice is the usual cost of forgetting that.

## Verification

Before you reply:

- `list_saved_logins` showed the site, and the fill reported success (or you escalated once).
- No password, token or cookie value appears anywhere in your reply or in a file you wrote.
- If you escalated, the reply says what you need in one sentence, with the page address.
