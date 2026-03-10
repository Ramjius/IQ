# Invoicing App

A Node.js/Express web-based invoicing application for Ramtechnologies. Originally built as an Electron desktop app, adapted to run as a web server in Replit.

## Features

- Dashboard showing all invoices and quotations with stats
- Create and save invoices with PDF export
- Create and save quotations with PDF export
- Reprint existing invoices/quotations as PDFs
- Status tracking for invoices (paid, pending, overdue)
- Pagination and sorting on dashboard tables

## Architecture

- **Backend**: Node.js with Express (server.js)
- **Database**: PostgreSQL (Replit built-in, via `pg` package)
- **PDF Generation**: PDFKit
- **Frontend**: Server-rendered HTML with inline JavaScript
- **Static files**: `public/` directory (invoices.html, quotations.html, logo.png)

## Key Files

- `server.js` - Main Express server with all API routes and page HTML
- `public/invoices.html` - New invoice creation form
- `public/quotations.html` - New quotation creation form
- `public/logo.png` - Company logo used in PDFs and header

## Database Tables

- `invoices` - Stores invoice records (invoice_number, customer_name, address, items JSON, total_amount, status, payment_details)
- `quotations` - Stores quotation records (quote_number, customer_name, address, salesperson, payment_terms, due_date, items JSON, total_amount)

## API Routes

- `GET /` - Dashboard page
- `GET /invoices` - New invoice form
- `GET /quotations` - New quotation form
- `GET /api/dashboard` - JSON data for dashboard stats
- `POST /api/save-invoice` - Save an invoice
- `POST /api/save-quotation` - Save a quotation
- `POST /api/export-invoice-pdf` - Export invoice as PDF
- `POST /api/export-quotation-pdf` - Export quotation as PDF
- `GET /api/reprint-invoice/:invoiceNumber` - Reprint existing invoice as PDF
- `GET /api/reprint-quotation/:quoteNumber` - Reprint existing quotation as PDF
- `GET /api/next-invoice-number` - Get next available invoice number
- `GET /api/next-quotation-number` - Get next available quotation number

## Environment Variables

- `DATABASE_URL` - PostgreSQL connection string (set automatically by Replit)

## Running

The app runs on port 5000 via the "Start application" workflow using `node server.js`.
