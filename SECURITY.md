# Security notes

- Never commit `.env`, `.env.local`, Render secret exports, access tokens, or mailbox passwords.
- Store production credentials only in Render Environment or an equivalent secret store.
- Use a unique `ADMIN_TOKEN` with at least 32 random characters.
- Rotate any credential that has been pasted into chat, email, issue trackers, or logs.
- The Phase 1 write endpoints require `Authorization: Bearer <ADMIN_TOKEN>`.
- Do not expose the test endpoints through a public frontend.
- Review Render logs before sharing them and redact tokens, email addresses, and internal identifiers.
- This phase does not connect to real mailboxes and does not send email.
