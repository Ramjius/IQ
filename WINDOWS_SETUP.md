# Run the invoicing app on Windows

This runs the app as a local web server. Open it in a browser on the same desktop at `http://localhost:5000`; the PowerShell launcher binds it to `127.0.0.1` so it is not offered to other computers on your network.

## Requirements

- Windows 10 or 11
- Current Node.js LTS release (npm is included)
- PostgreSQL for Windows, including its command-line tools (`pg_dump` and `pg_restore`)
- The app's existing PostgreSQL database backup if you want to keep current invoices, quotations, expenses, users, and settings

## One-time setup

1. Put the project in a stable folder, such as `C:\Apps\invoicing-app`.
2. Install Node.js and PostgreSQL. In PostgreSQL, create an empty database, for example `invoicing_app`.
3. Open PowerShell in the project folder and copy the environment template:

   ```powershell
   Copy-Item .env.example .env
   notepad .env
   ```

   Before your first Windows launch, export the current Replit database from the Replit project shell with:

   ```sh
   node scripts/export-current-database.js
   ```

   The script uses the configured `DATABASE_URL` without printing it and saves a custom-format backup under `backups/`. Download that file privately to the Windows computer, then restore it into the empty local database in pgAdmin. The backup folder is excluded from Git and deployment files.

4. Set `DATABASE_URL` to the local PostgreSQL database, `SESSION_SECRET` to a new random value, and keep `HOST=127.0.0.1`. A database URL has this shape; substitute your own local PostgreSQL username and password:

   ```text
   postgresql://<username>:<password>@localhost:5432/invoicing_app
   ```

   If the password contains URL-special characters, percent-encode them in the URL. Do not send or commit `.env`.

   To generate a session secret in PowerShell:

   ```powershell
   $bytes = New-Object byte[] 48
   [System.Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($bytes)
   [Convert]::ToBase64String($bytes)
   ```

   Copy the generated text into `SESSION_SECRET` in `.env`.

5. Restore your database backup into the empty local database before starting the app. In pgAdmin, right-click the database, choose **Restore**, select the custom-format `.backup` file, and restore it with ownership and privileges disabled if those options are shown. The server adds a few later columns at startup, but it does **not** create the full base schema for a brand-new empty database. If you intend to start without existing data, a complete initial schema is needed first.
6. Run the launcher:

   ```powershell
   .\scripts\start-windows.ps1
   ```

   The first run installs the locked project dependencies. Leave the PowerShell window open while using the app.
7. Open `http://localhost:5000` and sign in. To stop the app, press `Ctrl+C` in PowerShell.

If PowerShell blocks the script on your machine, run it for this invocation only with:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\start-windows.ps1
```

## Backups

Install PostgreSQL command-line tools and ensure `pg_dump` is on `PATH`. Then run:

```powershell
.\scripts\backup-database.ps1
```

Backups are written to `backups\`, which is excluded from Git and deployment files. Copy backups to a separate, protected drive or storage location; a backup on the same desktop is not enough protection against drive failure. The backup contains financial and account data, so do not upload it to a public location.

Also keep copies of any company logo/signature images and files under `uploads\invoices\` and `uploads\quotations\`; those are stored separately from PostgreSQL.

## Limits of local hosting

- The app is available only while the desktop is on and the server window is running.
- This setup is for use on that desktop; do not enable router port forwarding or change `HOST` to `0.0.0.0`.
- The app has been configured here to use PostgreSQL, so an empty database will not be initialized automatically.
