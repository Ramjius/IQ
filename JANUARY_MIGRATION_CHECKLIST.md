# January move-online checklist

Use this checklist when moving from the Windows desktop to a public host. Keep the local copy and its backups until the online copy has been verified.

## Before the move

- [ ] Choose the online app host and a managed PostgreSQL database.
- [ ] Confirm the host supports the app's current Node.js dependencies and can retain uploaded files, or arrange durable object/file storage.
- [ ] Schedule a short write freeze: stop entering or changing records while taking the final backup.
- [ ] Run `.\scripts\backup-database.ps1` and copy the resulting backup off the desktop.
- [ ] Separately copy the company logo, signature, and any required files in `uploads\invoices\` and `uploads\quotations\`.
- [ ] Record a baseline: invoice and quotation counts, paid/unpaid totals, expenses, user accounts, and settings.

## Secure the online deployment

- [ ] Set `DATABASE_URL` and a newly generated `SESSION_SECRET` through the host's secrets settings; never commit `.env` or database backups.
- [ ] Remove the server's built-in session-secret fallback before going public.
- [ ] Configure HTTPS, secure session cookies, and a persistent session store; the current in-memory session store is suitable only for local/single-process use.
- [ ] Review account creation and admin access. Do not leave an unrestricted signup route available unintentionally.
- [ ] If Google sign-in or email is used, update OAuth callback URLs and SMTP settings for the production domain.
- [ ] Set the production base URL and confirm password-reset links point to the production domain.
- [ ] Ensure uploaded images and files persist across app restarts and deployments.
- [ ] Set up automated database backups and test restoring one before relying on the deployment.

## Transfer and verify

- [ ] Create a fresh, empty production database.
- [ ] Restore the final PostgreSQL backup into it with PostgreSQL's `pg_restore` utility. Do not restore into a database containing records you need to keep.
- [ ] Copy the logo, signature, and any required uploaded files to the configured persistent storage.
- [ ] Start the online app and verify login, invoice and quotation lists, expense-to-invoice links, payment dates and transaction IDs, analytics, tax estimates, PDF generation, and email/reset flows if enabled.
- [ ] Compare the production counts and totals with the recorded baseline.
- [ ] Confirm a new record can be saved, edited, and retrieved after restarting the app.

## Cut over

- [ ] Point the production domain to the online host and verify HTTPS.
- [ ] Update any OAuth provider's approved domain and callback URL.
- [ ] Make the online copy the only copy used for new business records; avoid entering data in both local and online versions.
- [ ] Keep the final desktop backup in protected storage and retain the local copy until the online system has been used successfully and a restore has been tested.
