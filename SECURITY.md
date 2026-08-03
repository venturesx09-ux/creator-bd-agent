# Security notes

- Never commit `.env`, `.env.local`, Render secret exports, access tokens, or mailbox passwords.
- Store production credentials only in Render Environment or an equivalent secret store.
- Use a unique `ADMIN_TOKEN` with at least 32 random characters.
- Rotate any credential that has been pasted into chat, email, issue trackers, or logs.
- The Phase 1 write endpoints require `Authorization: Bearer <ADMIN_TOKEN>`.
- Feishu callbacks require request-signature, Verification Token, and App ID checks.
- Encrypted callback bodies are decrypted only in memory; message content is not logged.
- Mailbox passwords and synchronized message payloads are encrypted with AES-256-GCM before PostgreSQL storage.
- `MAILBOX_ENCRYPTION_KEY` must be a separate base64-encoded 32-byte secret and must never be committed.
- IMAP connections enforce TLS on port 993 or STARTTLS on port 143 and open the inbox read-only.
- The admin page keeps `ADMIN_TOKEN` in page memory only and does not persist it in browser storage.
- The current phase does not expose SMTP code and cannot send email.
- Do not expose the test endpoints through a public frontend.
- Review Render logs before sharing them and redact tokens, email addresses, and internal identifiers.
- Review database backups and access controls before storing production email data.
