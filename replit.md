# Invoicing App

A Node.js/Express web-based invoicing application for Ramtechnologies. Originally built as an Electron desktop app, adapted to run as a web server in Replit.

## Features

- Dashboard showing all invoices and quotations with stats
- Create and save invoices with PDF export
- Create and save quotations with PDF export
- Edit existing invoices/quotations (URL `?edit=NUMBER`)
- Reprint existing invoices/quotations as PDFs
- Status tracking for invoices (paid, pending, overdue)
- Pagination and sorting on dashboard tables
- Client database with auto-save and quick load picker
- Bulk import from JSON files (`uploads/invoices/`, `uploads/quotations/`)
- **Admin Panel** with login/signup, configurable company info, invoice/quotation numbering, logo/signature upload, PDF defaults

## Architecture

- **Backend**: Node.js with Express (`server.js`)
- **Database**: PostgreSQL (Replit built-in, via `pg` package)
- **Auth**: `express-session` + `bcrypt` (session-based, 24h cookie)
- **File Upload**: `multer` (logo and signature images)
- **PDF Generation**: PDFKit
- **Frontend**: Static HTML in `public/` + server-rendered dashboard

## Key Files

- `server.js` - Main Express server with all API routes and dashboard HTML
- `public/invoices.html` - Invoice creation/edit form
- `public/quotations.html` - Quotation creation/edit form
- `public/admin.html` - Admin panel (requires login)
- `public/admin-login.html` - Admin login page
- `public/admin-signup.html` - Admin account creation (first user only, or from logged-in session)
- `public/logo.png` - Company logo (replaceable via admin panel)
- `public/signature.png` - Signature image for PDFs (optional, replaceable via admin panel)

## Database Tables

- `invoices` - Invoice records (invoice_number, customer_name, address, items JSON, total_amount, status, payment_details)
- `quotations` - Quotation records (quote_number, customer_name, address, salesperson, payment_terms, due_date, items JSON, total_amount, payment_details)
- `clients` - Client directory (name, address, auto-upserted on save)
- `users` - Admin user accounts (username, email, password_hash, role)
- `app_settings` - Key-value settings store for all configurable options

## API Routes

### Public
- `GET /` - Dashboard page
- `GET /invoices` - New invoice form
- `GET /quotations` - New quotation form
- `GET /api/dashboard` - JSON data for dashboard stats
- `GET /api/next-invoice-number` - Next invoice number (settings-aware)
- `GET /api/next-quotation-number` - Next quotation number (settings-aware)
- `POST /api/save-invoice` / `PUT /api/update-invoice` - Save/update invoice
- `POST /api/save-quotation` / `PUT /api/update-quotation` - Save/update quotation
- `GET /api/invoice/:number` / `GET /api/quotation/:number` - Fetch record for edit
- `POST /api/export-invoice-pdf` / `POST /api/export-quotation-pdf` - Export PDF
- `GET /api/reprint-invoice/:number` / `GET /api/reprint-quotation/:number` - Reprint PDF
- `GET /api/clients` - List clients

### Admin (session required)
- `GET /admin` - Admin panel
- `GET /admin/login` - Login page
- `GET /admin/signup` - Signup page
- `GET /api/settings` / `POST /api/settings` - Get/update settings
- `POST /api/settings/reset-invoice-sequence` - Set invoice start number
- `POST /api/settings/reset-quotation-sequence` - Set quotation start number
- `POST /api/upload-logo` - Upload new logo
- `POST /api/upload-signature` - Upload new signature
- `POST /api/auth/login` / `POST /api/auth/logout` - Auth
- `POST /api/auth/signup` - Create user account
- `GET /api/auth/users` - List admin users
- `POST /api/auth/change-password` - Change own password

## Environment Variables

- `DATABASE_URL` - PostgreSQL connection string (set automatically by Replit)
- `SESSION_SECRET` - Optional; defaults to a built-in secret

## Running

The app runs on port 5000 via the "Start application" workflow using `node server.js`.

## First-Time Setup

1. Navigate to `/admin/signup` to create the first admin account
2. Log in at `/admin/login`
3. Configure company info, logo, numbering format, and PDF defaults in the admin panel
