const express = require('express');
const bodyParser = require('body-parser');
const cors = require('cors');
const PDFDocument = require('pdfkit');
const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');
const bcrypt = require('bcrypt');
const session = require('express-session');
const multer = require('multer');
const passport = require('passport');
const GoogleStrategy = require('passport-google-oauth20').Strategy;
const nodemailer = require('nodemailer');
const crypto = require('crypto');
require('dotenv').config();

const app = express();
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));
app.use(cors());
app.use(session({
  secret: process.env.SESSION_SECRET || 'invoicing-app-secret-2025',
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 24 * 60 * 60 * 1000 } // 24 hours
}));
app.use(express.static(path.join(__dirname, 'public'))); // serve static files

// ─── PASSPORT / GOOGLE OAUTH ─────────────────────────────────────────────────
app.use(passport.initialize());
app.use(passport.session());

const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID;
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET;
const BASE_URL = process.env.BASE_URL ||
  (process.env.REPLIT_DEV_DOMAIN ? `https://${process.env.REPLIT_DEV_DOMAIN}` : 'http://localhost:5000');

if (GOOGLE_CLIENT_ID && GOOGLE_CLIENT_SECRET) {
  passport.use(new GoogleStrategy({
    clientID: GOOGLE_CLIENT_ID,
    clientSecret: GOOGLE_CLIENT_SECRET,
    callbackURL: `${BASE_URL}/auth/google/callback`,
  }, (accessToken, refreshToken, profile, done) => {
    const email = (profile.emails && profile.emails[0]) ? profile.emails[0].value : '';
    const displayName = profile.displayName || email;
    // Find or create user by google_id
    const findSql = 'SELECT * FROM users WHERE google_id = ?';
    connection.query(findSql, [profile.id], (err, rows) => {
      if (err) return done(err);
      if (rows.length > 0) return done(null, rows[0]);
      // Check if email already exists (link accounts)
      connection.query('SELECT * FROM users WHERE email = ?', [email], (err2, rows2) => {
        if (err2) return done(err2);
        if (rows2.length > 0) {
          // Link Google ID to existing account
          connection.query('UPDATE users SET google_id = ? WHERE email = ?', [profile.id, email], (err3) => {
            if (err3) return done(err3);
            return done(null, rows2[0]);
          });
        } else {
          // Create new user
          const username = displayName.replace(/\s+/g, '_').toLowerCase() + '_' + profile.id.slice(-4);
          connection.query(
            'INSERT INTO users (username, email, google_id) VALUES (?, ?, ?) RETURNING *',
            [username, email, profile.id],
            (err4, newRows) => {
              if (err4) return done(err4);
              return done(null, newRows[0]);
            }
          );
        }
      });
    });
  }));
} else {
  console.warn('Google OAuth not configured — set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET to enable it.');
}

passport.serializeUser((user, done) => done(null, user.id));
passport.deserializeUser((id, done) => {
  connection.query('SELECT * FROM users WHERE id = ?', [id], (err, rows) => {
    done(err, rows[0] || null);
  });
});

// Multer setup for file uploads
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, path.join(__dirname, 'public')),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    const name = file.fieldname === 'logo' ? 'logo' : 'signature';
    cb(null, name + ext);
  }
});
const upload = multer({ storage, limits: { fileSize: 5 * 1024 * 1024 } });

// Auth middleware — supports both session (username/password) and Passport (Google OAuth)
function requireAuth(req, res, next) {
  if ((req.session && req.session.userId) || (req.user && req.user.id)) return next();
  res.redirect('/login');
}

function requireApiAuth(req, res, next) {
  if ((req.session && req.session.userId) || (req.user && req.user.id)) return next();
  res.status(401).json({ error: 'Sign in to view and manage this financial data.' });
}

// Settings helper — fetch all settings as an object
async function getSettings() {
  return new Promise((resolve, reject) => {
    connection.query('SELECT key, value FROM app_settings', (err, rows) => {
      if (err) return reject(err);
      const s = {};
      (rows || []).forEach(r => { s[r.key] = r.value; });
      resolve(s);
    });
  });
}

// PostgreSQL connection setup
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
});

// Helper to run queries (compatible interface replacing MySQL callback style)
const connection = {
  query: (sql, params, callback) => {
    if (typeof params === 'function') {
      callback = params;
      params = [];
    }
    // Convert MySQL ? placeholders to PostgreSQL $1, $2, ...
    let i = 1;
    const pgSql = sql.replace(/\?/g, () => `$${i++}`);
    pool.query(pgSql, params, (err, result) => {
      if (err) return callback(err, null);
      callback(null, result.rows);
    });
  }
};

function queryRows(sql, params = []) {
  return new Promise((resolve, reject) => {
    connection.query(sql, params, (err, rows) => err ? reject(err) : resolve(rows));
  });
}

pool.connect((err, client, release) => {
  if (err) {
    console.error('Error connecting to PostgreSQL:', err);
    return;
  }
  release();
  console.log('Connected to PostgreSQL database');
});

pool.query(`
  ALTER TABLE invoices
    ADD COLUMN IF NOT EXISTS payment_mode TEXT NOT NULL DEFAULT 'CHEQUE',
    ADD COLUMN IF NOT EXISTS payment_date DATE,
    ADD COLUMN IF NOT EXISTS transaction_id TEXT
`).catch(err => console.error('Error adding invoice payment fields:', err));

// Create password_reset_tokens table if it doesn't exist
pool.query(`
  CREATE TABLE IF NOT EXISTS password_reset_tokens (
    id SERIAL PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    token TEXT NOT NULL UNIQUE,
    expires_at TIMESTAMPTZ NOT NULL,
    used BOOLEAN NOT NULL DEFAULT FALSE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )
`).catch(err => console.error('Error creating password_reset_tokens table:', err));

// Email transporter (configured via SMTP_* env vars)
function createMailTransporter() {
  const host = process.env.SMTP_HOST;
  const port = parseInt(process.env.SMTP_PORT || '587');
  const user = process.env.SMTP_USER;
  const pass = process.env.SMTP_PASS;
  if (!host || !user || !pass) return null;
  return nodemailer.createTransport({
    host, port,
    secure: port === 465,
    auth: { user, pass },
  });
}

// Route for serving the dashboard
app.get('/login', (req, res) => {
  if (req.session && req.session.userId) return res.redirect('/');
  res.sendFile(path.join(__dirname, 'public', 'login.html'));
});

app.get('/forgot-password', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'forgot-password.html'));
});

app.get('/reset-password', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'reset-password.html'));
});

app.get('/', requireAuth, (req, res) => {
  const html = `
    <!DOCTYPE html>
    <html lang="en">
    <head>
      <meta charset="UTF-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      <title>Invoicing App - Dashboard</title>
      <style>
        body {
          font-family: Arial, sans-serif;
          margin: 0;
          padding: 0;
          background-color: #f4f4f4;
        }
        header {
          display: flex;
          justify-content: space-between;
          align-items: center;
          padding: 20px;
          background-color: #ffffff;
          color: black;
        }
        header h1 {
          margin: 0;
          font-size: 36px;
        }
        header img {
          height: 60px;
        }
        .nav-menu {
          background-color: #212121;
          padding: 10px 20px;
          display: flex;
          align-items: center;
          justify-content: center;
          flex-wrap: wrap;
          gap: 4px;
        }
        .nav-menu a {
          color: white;
          text-decoration: none;
          margin: 0 4px;
          font-size: 15px;
          padding: 6px 10px;
          border-radius: 4px;
          transition: background-color 0.3s;
        }
        .nav-menu a:hover {
          background-color: #424242;
        }
        .nav-menu a.active {
          background-color: #4caf50;
        }
        .container {
          display: flex;
          justify-content: space-between;
          gap: 20px;
          padding: 20px;
        }
        .tables-section {
          flex: 3;
          background-color: #e91e63;
          padding: 20px;
          border-radius: 10px;
          color: white;
        }
        .tables-section h2 {
          margin: 0 0 10px 0;
          font-size: 24px;
        }
        .dashboard {
          display: grid;
          grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
          gap: 15px;
          margin-bottom: 20px;
        }
        .card {
          background-color: white;
          border-radius: 5px;
          padding: 15px;
          box-shadow: 0 1px 3px rgba(0,0,0,0.1);
          text-align: center;
        }
        .card h3 {
          margin: 0;
          color: #7f8c8d;
          font-size: 14px;
        }
        .card p {
          font-size: 20px;
          font-weight: 600;
          margin: 5px 0 0;
          color: #333;
        }
        .controls {
          display: flex;
          justify-content: space-between;
          align-items: center;
          margin-bottom: 20px;
          gap: 10px;
          flex-wrap: wrap;
        }
        .filters select {
          padding: 8px;
          border: 1px solid #ddd;
          border-radius: 4px;
          background-color: white;
          color: #333;
        }
        .sort-button {
          padding: 8px 15px;
          background-color: #007bff;
          color: white;
          border: none;
          border-radius: 4px;
          cursor: pointer;
          transition: background-color 0.3s;
        }
        .sort-button:hover {
          background-color: #0056b3;
        }
        .table-container {
          background-color: #fff;
          border-radius: 5px;
          margin-bottom: 20px;
          overflow-x: auto;
        }
        table {
          width: 100%;
          border-collapse: collapse;
          background-color: #fff;
          color: #333;
        }
        th, td {
          padding: 10px;
          text-align: left;
          border-bottom: 1px solid #ddd;
        }
        th {
          background-color: #ffe0b2;
          color: #333;
        }
        td {
          background-color: #fff3e0;
        }
        tr:nth-child(even) td {
          background-color: #fff;
        }
        tr:hover {
          background-color: #f1f1f1;
        }
        .status {
          padding: 5px 10px;
          border-radius: 20px;
          font-size: 12px;
          font-weight: 500;
          text-align: center;
          display: inline-block;
          min-width: 80px;
        }
        .paid {
          background-color: #d5f5e3;
          color: #27ae60;
        }
        .pending {
          background-color: #fcf3cf;
          color: #f1c40f;
        }
        .overdue {
          background-color: #fadbd8;
          color: #e74c3c;
        }
        button {
          padding: 5px 10px;
          background-color: #28a745;
          color: white;
          border: none;
          border-radius: 3px;
          cursor: pointer;
        }
        button:hover {
          background-color: #218838;
        }
        .pagination {
          display: flex;
          justify-content: center;
          align-items: center;
          gap: 10px;
          margin-top: 10px;
        }
        .pagination button {
          padding: 5px 10px;
          background-color: #007bff;
        }
        .pagination button:hover {
          background-color: #0056b3;
        }
        .pagination button:disabled {
          background-color: #cccccc;
          cursor: not-allowed;
        }
        .buttons-section {
          flex: 1;
          background-color: #4caf50;
          padding: 20px;
          border-radius: 10px;
          display: flex;
          flex-direction: column;
          justify-content: flex-start;
          align-items: center;
          gap: 20px;
        }
        .buttons-section button {
          padding: 15px 30px;
          font-size: 16px;
          cursor: pointer;
          background-color: #212121;
          color: white;
          border: none;
          border-radius: 25px;
          width: 100%;
          max-width: 200px;
          text-align: center;
          transition: background-color 0.3s;
        }
        .buttons-section button:hover {
          background-color: #424242;
        }
        @media (max-width: 768px) {
          .container {
            flex-direction: column;
          }
          .buttons-section {
            flex-direction: row;
            flex-wrap: wrap;
            justify-content: center;
          }
          th:nth-child(4), td:nth-child(4) {
            display: none;
          }
        }
      </style>
    </head>
    <body>
      <header>
        <h1>Dashboard</h1>
        <img src="/logo.png" alt="Company Logo">
      </header>
      <div class="nav-menu">
        <a href="/" class="active">Dashboard</a>
        <a href="/invoices">Invoices</a>
        <a href="/quotations">Quotations</a>
        <a href="/clients">Clients</a>
        <a href="/expenses">Expenses</a>
        <a href="/analytics">Analytics</a>
        <a href="/taxes">Taxes</a>
        <a href="/admin" style="margin-left:auto;background:#424242;padding:5px 14px;border-radius:4px;">&#9881; Admin</a>
      </div>
      <div class="container">
        <div class="tables-section">
          <div class="dashboard" id="dashboardStats">
            <div class="card">
              <h3>Total Invoices</h3>
              <p id="totalInvoices">0</p>
            </div>
            <div class="card">
              <h3>Paid</h3>
              <p id="paidInvoices">0</p>
            </div>
            <div class="card">
              <h3>Pending</h3>
              <p id="pendingInvoices">0</p>
            </div>
            <div class="card">
              <h3>Overdue</h3>
              <p id="overdueInvoices">0</p>
            </div>
            <div class="card">
              <h3>Total Quotations</h3>
              <p id="totalQuotations">0</p>
            </div>
          </div>

          <h2>Invoices</h2>
          <div class="controls">
            <div class="filters">
              <select id="statusFilter">
                <option value="all">All Status</option>
                <option value="paid">Paid</option>
                <option value="pending">Pending</option>
                <option value="overdue">Overdue</option>
              </select>
            </div>
            <button class="sort-button" id="sortInvoicesBtn">Sort by Date ↓</button>
          </div>
          <div class="table-container">
            <table id="invoicesTable">
              <thead>
                <tr>
                  <th>Date</th>
                  <th>Invoice Number</th>
                  <th>Customer</th>
                  <th>Total Amount</th>
                  <th>Status</th>
                  <th>Action</th>
                </tr>
              </thead>
              <tbody></tbody>
            </table>
          </div>
          <div class="pagination" id="invoicesPagination">
            <button id="prevInvoicesPage">Previous</button>
            <span id="invoicesPageInfo">Page 1 of 1</span>
            <button id="nextInvoicesPage">Next</button>
          </div>

          <h2>Quotations</h2>
          <div class="controls">
            <div class="filters"></div>
            <button class="sort-button" id="sortQuotationsBtn">Sort by Date ↓</button>
          </div>
          <div class="table-container">
            <table id="quotationsTable">
              <thead>
                <tr>
                  <th>Date</th>
                  <th>Quote Number</th>
                  <th>Customer</th>
                  <th>Total Amount</th>
                  <th>Action</th>
                </tr>
              </thead>
              <tbody></tbody>
            </table>
          </div>
          <div class="pagination" id="quotationsPagination">
            <button id="prevQuotationsPage">Previous</button>
            <span id="quotationsPageInfo">Page 1 of 1</span>
            <button id="nextQuotationsPage">Next</button>
          </div>
        </div>
        <div class="buttons-section">
          <button onclick="window.location.href='/invoices'">Invoices</button>
          <button onclick="window.location.href='/quotations'">Quotes</button>
          <button onclick="importData('invoices')" style="background-color: #007bff;">Import Invoices</button>
          <button onclick="importData('quotations')" style="background-color: #007bff;">Import Quotes</button>
        </div>
      </div>
      <script>
        function importData(type) {
          if (!confirm("Import JSON files from uploads/" + type + "?")) return;
          fetch('/api/import-from-directory', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ type: type })
          })
          .then(function(r) { return r.json(); })
          .then(function(data) {
            alert(data.message + ": " + data.importedCount + " imported, " + data.skippedCount + " skipped (duplicates).");
            location.reload();
          })
          .catch(function(err) { alert('Error importing: ' + err.message); });
        }

        // Pagination and sorting state
        let invoices = [];
        let quotations = [];
        let filteredInvoices = [];
        let filteredQuotations = [];
        let currentInvoicesPage = 1;
        let currentQuotationsPage = 1;
        const itemsPerPage = 5;
        let sortInvoicesAscending = false;
        let sortQuotationsAscending = false;

        // Fetch data and initialize
        fetch('/api/dashboard')
          .then(response => response.json())
          .then(data => {
            invoices = data.invoices;
            quotations = data.quotations;
            filteredInvoices = [...invoices];
            filteredQuotations = [...quotations];

            updateDashboardStats();
            filterAndSortInvoices();
            filterAndSortQuotations();
          })
          .catch(err => console.error('Error fetching dashboard data:', err));

        // Update dashboard stats
        function updateDashboardStats() {
          document.getElementById('totalInvoices').textContent = invoices.length;
          document.getElementById('paidInvoices').textContent = invoices.filter(i => i.status === 'paid').length;
          document.getElementById('pendingInvoices').textContent = invoices.filter(i => i.status === 'pending').length;
          document.getElementById('overdueInvoices').textContent = invoices.filter(i => i.status === 'overdue').length;
          document.getElementById('totalQuotations').textContent = quotations.length;
        }

        // Filter and sort invoices
        function filterAndSortInvoices() {
          const statusFilter = document.getElementById('statusFilter').value;
          filteredInvoices = invoices.filter(invoice => {
            return statusFilter === 'all' || invoice.status === statusFilter;
          });

          filteredInvoices.sort((a, b) => {
            const dateA = new Date(a.date);
            const dateB = new Date(b.date);
            return sortInvoicesAscending ? dateA - dateB : dateB - dateA;
          });

          currentInvoicesPage = 1;
          renderInvoices();
        }

        // Filter and sort quotations
        function filterAndSortQuotations() {
          filteredQuotations = [...quotations];
          filteredQuotations.sort((a, b) => {
            const dateA = new Date(a.date);
            const dateB = new Date(b.date);
            return sortQuotationsAscending ? dateA - dateB : dateB - dateA;
          });

          currentQuotationsPage = 1;
          renderQuotations();
        }

        // Render invoices table
        function renderInvoices() {
          const tbody = document.querySelector('#invoicesTable tbody');
          tbody.innerHTML = '';

          const startIndex = (currentInvoicesPage - 1) * itemsPerPage;
          const endIndex = startIndex + itemsPerPage;
          const paginatedInvoices = filteredInvoices.slice(startIndex, endIndex);

          if (paginatedInvoices.length === 0) {
            const row = document.createElement('tr');
            row.innerHTML = \`<td colspan="6" style="text-align: center;">No invoices found</td>\`;
            tbody.appendChild(row);
          } else {
            paginatedInvoices.forEach(i => {
              const row = document.createElement('tr');
              row.innerHTML = \`
                <td>\${new Date(i.date).toLocaleDateString()}</td>
                <td>\${i.invoice_number}</td>
                <td>\${i.customer_name}</td>
                <td>Kshs \${i.total_amount}</td>
                <td><span class="status \${i.status || 'pending'}">\${capitalizeFirstLetter(i.status || 'pending')}</span></td>
                <td style="white-space: nowrap;">
                  <button onclick="reprintInvoice('\${i.invoice_number}')">Reprint</button>
                  <button onclick="editInvoice('\${i.invoice_number}')" style="background-color:#ff9800; margin-left:4px;">Edit</button>
                </td>
              \`;
              tbody.appendChild(row);
            });
          }

          const totalPages = Math.ceil(filteredInvoices.length / itemsPerPage);
          document.getElementById('invoicesPageInfo').textContent = \`Page \${currentInvoicesPage} of \${totalPages || 1}\`;
          document.getElementById('prevInvoicesPage').disabled = currentInvoicesPage === 1;
          document.getElementById('nextInvoicesPage').disabled = currentInvoicesPage >= totalPages;
        }

        // Render quotations table
        function renderQuotations() {
          const tbody = document.querySelector('#quotationsTable tbody');
          tbody.innerHTML = '';

          const startIndex = (currentQuotationsPage - 1) * itemsPerPage;
          const endIndex = startIndex + itemsPerPage;
          const paginatedQuotations = filteredQuotations.slice(startIndex, endIndex);

          if (paginatedQuotations.length === 0) {
            const row = document.createElement('tr');
            row.innerHTML = \`<td colspan="5" style="text-align: center;">No quotations found</td>\`;
            tbody.appendChild(row);
          } else {
            paginatedQuotations.forEach(q => {
              const row = document.createElement('tr');
              row.innerHTML = \`
                <td>\${new Date(q.date).toLocaleDateString()}</td>
                <td>\${q.quote_number}</td>
                <td>\${q.customer_name}</td>
                <td>Kshs \${q.total_amount}</td>
                <td style="white-space: nowrap;">
                  <button onclick="reprintQuotation('\${q.quote_number}')">Reprint</button>
                  <button onclick="editQuotation('\${q.quote_number}')" style="background-color:#ff9800; margin-left:4px;">Edit</button>
                </td>
              \`;
              tbody.appendChild(row);
            });
          }

          const totalPages = Math.ceil(filteredQuotations.length / itemsPerPage);
          document.getElementById('quotationsPageInfo').textContent = \`Page \${currentQuotationsPage} of \${totalPages || 1}\`;
          document.getElementById('prevQuotationsPage').disabled = currentQuotationsPage === 1;
          document.getElementById('nextQuotationsPage').disabled = currentQuotationsPage >= totalPages;
        }

        // Reprint functions
        function reprintInvoice(invoiceNumber) {
          window.location.href = \`/api/reprint-invoice/\${invoiceNumber}\`;
        }

        function reprintQuotation(quoteNumber) {
          window.location.href = \`/api/reprint-quotation/\${quoteNumber}\`;
        }

        // Edit functions
        function editInvoice(invoiceNumber) {
          window.location.href = \`/invoices?edit=\${encodeURIComponent(invoiceNumber)}\`;
        }

        function editQuotation(quoteNumber) {
          window.location.href = \`/quotations?edit=\${encodeURIComponent(quoteNumber)}\`;
        }

        // Event listeners
        document.getElementById('statusFilter').addEventListener('change', filterAndSortInvoices);
        document.getElementById('sortInvoicesBtn').addEventListener('click', () => {
          sortInvoicesAscending = !sortInvoicesAscending;
          document.getElementById('sortInvoicesBtn').textContent = \`Sort by Date \${sortInvoicesAscending ? '↑' : '↓'}\`;
          filterAndSortInvoices();
        });
        document.getElementById('sortQuotationsBtn').addEventListener('click', () => {
          sortQuotationsAscending = !sortQuotationsAscending;
          document.getElementById('sortQuotationsBtn').textContent = \`Sort by Date \${sortQuotationsAscending ? '↑' : '↓'}\`;
          filterAndSortQuotations();
        });
        document.getElementById('prevInvoicesPage').addEventListener('click', () => {
          if (currentInvoicesPage > 1) {
            currentInvoicesPage--;
            renderInvoices();
          }
        });
        document.getElementById('nextInvoicesPage').addEventListener('click', () => {
          const totalPages = Math.ceil(filteredInvoices.length / itemsPerPage);
          if (currentInvoicesPage < totalPages) {
            currentInvoicesPage++;
            renderInvoices();
          }
        });
        document.getElementById('prevQuotationsPage').addEventListener('click', () => {
          if (currentQuotationsPage > 1) {
            currentQuotationsPage--;
            renderQuotations();
          }
        });
        document.getElementById('nextQuotationsPage').addEventListener('click', () => {
          const totalPages = Math.ceil(filteredQuotations.length / itemsPerPage);
          if (currentQuotationsPage < totalPages) {
            currentQuotationsPage++;
            renderQuotations();
          }
        });

        // Helper function to capitalize first letter
        function capitalizeFirstLetter(string) {
          return string.charAt(0).toUpperCase() + string.slice(1);
        }
      </script>
    </body>
    </html>
  `;
  res.send(html);
});

// Serve invoices page
app.get('/invoices', requireAuth, (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'invoices.html'));
});

app.get('/quotations', requireAuth, (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'quotations.html'));
});

app.get('/clients', requireAuth, (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'clients.html'));
});

app.get('/expenses', requireAuth, (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'expenses.html'));
});

app.get('/analytics', requireAuth, (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'analytics.html'));
});

app.get('/taxes', requireAuth, (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'taxes.html'));
});

// Success and error pages
app.get('/success', (req, res) => {
  res.send(`
    <!DOCTYPE html>
    <html lang="en">
    <head>
      <meta charset="UTF-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      <title>Success</title>
      <style>
        body { 
          font-family: Arial, sans-serif; 
          text-align: center; 
          padding: 40px; 
          background-color: #f4f4f4; 
        }
        .message { 
          background-color: white; 
          padding: 30px; 
          border-radius: 10px; 
          box-shadow: 0 0 10px rgba(0,0,0,0.1); 
          max-width: 500px; 
          margin: 0 auto; 
        }
        h1 { color: #4caf50; }
        .nav-links { 
          margin-top: 30px; 
        }
        .nav-links a { 
          display: inline-block; 
          margin: 0 10px; 
          padding: 10px 20px; 
          background-color: #e91e63; 
          color: white; 
          text-decoration: none; 
          border-radius: 5px; 
          transition: background-color 0.3s; 
        }
        .nav-links a:hover { 
          background-color: #c2185b; 
        }
      </style>
    </head>
    <body>
      <div class="message">
        <h1>Success!</h1>
        <p>Your operation was completed successfully.</p>
        <div class="nav-links">
          <a href="/">Dashboard</a>
          <a href="/invoices">Invoices</a>
          <a href="/quotations">Quotations</a>
        </div>
      </div>
    </body>
    </html>
  `);
});

app.get('/error', (req, res) => {
  res.send(`
    <!DOCTYPE html>
    <html lang="en">
    <head>
      <meta charset="UTF-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      <title>Error</title>
      <style>
        body { 
          font-family: Arial, sans-serif; 
          text-align: center; 
          padding: 40px; 
          background-color: #f4f4f4; 
        }
        .message { 
          background-color: white; 
          padding: 30px; 
          border-radius: 10px; 
          box-shadow: 0 0 10px rgba(0,0,0,0.1); 
          max-width: 500px; 
          margin: 0 auto; 
        }
        h1 { color: #f44336; }
        .nav-links { 
          margin-top: 30px; 
        }
        .nav-links a { 
          display: inline-block; 
          margin: 0 10px; 
          padding: 10px 20px; 
          background-color: #e91e63; 
          color: white; 
          text-decoration: none; 
          border-radius: 5px; 
          transition: background-color 0.3s; 
        }
        .nav-links a:hover { 
          background-color: #c2185b; 
        }
      </style>
    </head>
    <body>
      <div class="message">
        <h1>Error</h1>
        <p>An error occurred while processing your request.</p>
        <div class="nav-links">
          <a href="/">Dashboard</a>
          <a href="/invoices">Invoices</a>
          <a href="/quotations">Quotations</a>
        </div>
      </div>
    </body>
    </html>
  `);
});

// Save Quotation
function getOptionalIssueDate(issueDate, res, documentLabel) {
  if (issueDate === undefined || issueDate === null || issueDate === '') return null;
  const isValid = typeof issueDate === 'string' &&
    /^\d{4}-\d{2}-\d{2}$/.test(issueDate) &&
    !Number.isNaN(Date.parse(`${issueDate}T00:00:00Z`)) &&
    new Date(`${issueDate}T00:00:00Z`).toISOString().slice(0, 10) === issueDate;
  if (!isValid) {
    res.status(400).json({ error: `Enter a valid ${documentLabel} date` });
    return undefined;
  }
  return issueDate;
}

function formatDocumentDate(dateValue) {
  if (!dateValue) return new Date().toLocaleDateString();
  const dateString = String(dateValue);
  if (/^\d{4}-\d{2}-\d{2}$/.test(dateString)) {
    const [year, month, day] = dateString.split('-').map(Number);
    return new Date(year, month - 1, day).toLocaleDateString();
  }
  const parsed = new Date(dateValue);
  return Number.isNaN(parsed.getTime()) ? new Date().toLocaleDateString() : parsed.toLocaleDateString();
}

app.post('/api/save-quotation', (req, res) => {
  const { quoteNumber, issueDate: requestedIssueDate, customerName, address, salesperson, paymentTerms, dueDate, items, totalAmount, paymentDetails } = req.body;
  const issueDate = getOptionalIssueDate(requestedIssueDate, res, 'quotation');
  if (issueDate === undefined) return;

  // Check for duplicate quote number
  connection.query('SELECT id FROM quotations WHERE quote_number = ?', [quoteNumber], (dupErr, dupRows) => {
    if (dupErr) return res.status(500).json({ error: 'Database error' });
    if (dupRows.length > 0) return res.status(409).json({ error: `Quote number "${quoteNumber}" already exists. Please use a different number.` });

    const upsertClient = `INSERT INTO clients (name, address) VALUES (?, ?) ON CONFLICT (name) DO UPDATE SET address = EXCLUDED.address`;
    connection.query(upsertClient, [customerName, address], (clientErr) => {
      if (clientErr) console.error('Error upserting client:', clientErr);
      const query = `INSERT INTO quotations (date, quote_number, customer_name, address, salesperson, payment_terms, due_date, items, total_amount, payment_details) VALUES (COALESCE(?, NOW()), ?, ?, ?, ?, ?, ?, ?, ?, ?)`;
      connection.query(query, [issueDate, quoteNumber, customerName, address, salesperson, paymentTerms, dueDate, JSON.stringify(items), totalAmount, paymentDetails], (err) => {
        if (err) { console.error('Database Error:', err); return res.status(500).json({ error: 'Failed to save quotation' }); }
        res.json({ success: true });
      });
    });
  });
});

// Save Invoice
function getInvoicePaymentFields(req, res) {
  const { status, paymentMode, paymentDate, transactionId } = req.body;
  const mode = paymentMode || 'CHEQUE';
  if (!['CHEQUE', 'M-PESA'].includes(mode)) {
    res.status(400).json({ error: 'Payment mode must be CHEQUE or M-PESA' });
    return null;
  }
  if (status === 'paid') {
    const validDate = typeof paymentDate === 'string' &&
      /^\d{4}-\d{2}-\d{2}$/.test(paymentDate) &&
      !Number.isNaN(Date.parse(`${paymentDate}T00:00:00Z`)) &&
      new Date(`${paymentDate}T00:00:00Z`).toISOString().slice(0, 10) === paymentDate;
    if (!validDate || typeof transactionId !== 'string' || !transactionId.trim()) {
      res.status(400).json({ error: 'Payment date and transaction ID are required for a paid invoice' });
      return null;
    }
  }
  return {
    paymentMode: mode,
    paymentDate: status === 'paid' ? paymentDate : null,
    transactionId: status === 'paid' ? transactionId.trim() : null,
  };
}

app.post('/api/save-invoice', (req, res) => {
  const { invoiceNumber, issueDate: requestedIssueDate, customerName, address, items, totalAmount, status } = req.body;
  const issueDate = getOptionalIssueDate(requestedIssueDate, res, 'invoice');
  if (issueDate === undefined) return;
  const payment = getInvoicePaymentFields(req, res);
  if (!payment) return;

  // Check for duplicate invoice number
  connection.query('SELECT id FROM invoices WHERE invoice_number = ?', [invoiceNumber], (dupErr, dupRows) => {
    if (dupErr) return res.status(500).json({ error: 'Database error' });
    if (dupRows.length > 0) return res.status(409).json({ error: `Invoice number "${invoiceNumber}" already exists. Please use a different number.` });

    const upsertClient = `INSERT INTO clients (name, address) VALUES (?, ?) ON CONFLICT (name) DO UPDATE SET address = EXCLUDED.address`;
    connection.query(upsertClient, [customerName, address], (clientErr) => {
      if (clientErr) console.error('Error upserting client:', clientErr);
      const query = `INSERT INTO invoices (date, invoice_number, customer_name, address, items, total_amount, payment_mode, payment_date, transaction_id, status) VALUES (COALESCE(?, NOW()), ?, ?, ?, ?, ?, ?, ?, ?, ?)`;
      connection.query(query, [issueDate, invoiceNumber, customerName, address, JSON.stringify(items), totalAmount, payment.paymentMode, payment.paymentDate, payment.transactionId, status || 'pending'], (err) => {
        if (err) { console.error('Database Error:', err); return res.status(500).json({ error: 'Failed to save invoice' }); }
        res.json({ success: true });
      });
    });
  });
});

// Get Clients
app.get('/api/clients', (req, res) => {
  const search = req.query.search || '';
  const searchPattern = `%${search}%`;
  connection.query(
    'SELECT id, name, address, email, phone, created_at FROM clients WHERE name ILIKE ? OR email ILIKE ? OR phone ILIKE ? ORDER BY name ASC',
    [searchPattern, searchPattern, searchPattern],
    (err, results) => {
      if (err) return res.status(500).send('Failed to fetch clients');
      res.json(results);
    }
  );
});

app.post('/api/clients', (req, res) => {
  const { name, address, email, phone } = req.body;
  if (!name) return res.status(400).json({ error: 'Name is required' });
  connection.query(
    'INSERT INTO clients (name, address, email, phone) VALUES (?, ?, ?, ?) ON CONFLICT (name) DO UPDATE SET address = EXCLUDED.address, email = EXCLUDED.email, phone = EXCLUDED.phone RETURNING *',
    [name, address || '', email || '', phone || ''],
    (err, results) => {
      if (err) return res.status(500).json({ error: err.message });
      res.json({ success: true, client: results[0] });
    }
  );
});

app.put('/api/clients/:id', (req, res) => {
  const { name, address, email, phone } = req.body;
  if (!name) return res.status(400).json({ error: 'Name is required' });
  connection.query(
    'UPDATE clients SET name = ?, address = ?, email = ?, phone = ? WHERE id = ? RETURNING *',
    [name, address || '', email || '', phone || '', req.params.id],
    (err, results) => {
      if (err) return res.status(500).json({ error: err.message });
      if (!results.length) return res.status(404).json({ error: 'Client not found' });
      res.json({ success: true, client: results[0] });
    }
  );
});

app.delete('/api/clients/:id', (req, res) => {
  connection.query('DELETE FROM clients WHERE id = ?', [req.params.id], (err) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json({ success: true });
  });
});

// Get single invoice for editing
app.get('/api/invoice/:invoiceNumber', (req, res) => {
  connection.query('SELECT * FROM invoices WHERE invoice_number = ?', [req.params.invoiceNumber], (err, results) => {
    if (err) return res.status(500).json({ error: 'Failed to fetch invoice' });
    if (!results.length) return res.status(404).json({ error: 'Invoice not found' });
    const inv = results[0];
    if (typeof inv.items === 'string') {
      try { inv.items = JSON.parse(inv.items); } catch (e) { inv.items = []; }
    }
    res.json(inv);
  });
});

// Get single quotation for editing
app.get('/api/quotation/:quoteNumber', (req, res) => {
  connection.query('SELECT * FROM quotations WHERE quote_number = ?', [req.params.quoteNumber], (err, results) => {
    if (err) return res.status(500).json({ error: 'Failed to fetch quotation' });
    if (!results.length) return res.status(404).json({ error: 'Quotation not found' });
    const q = results[0];
    if (typeof q.items === 'string') {
      try { q.items = JSON.parse(q.items); } catch (e) { q.items = []; }
    }
    res.json(q);
  });
});

// Update invoice (supports number change via originalInvoiceNumber)
app.put('/api/update-invoice', (req, res) => {
  const { invoiceNumber, originalInvoiceNumber, issueDate: requestedIssueDate, customerName, address, items, totalAmount, status } = req.body;
  const issueDate = getOptionalIssueDate(requestedIssueDate, res, 'invoice');
  if (issueDate === undefined) return;
  const payment = getInvoicePaymentFields(req, res);
  if (!payment) return;
  const lookupNumber = originalInvoiceNumber || invoiceNumber;
  const newNumber = invoiceNumber;

  // If number changed, check new number isn't already taken by a different record
  if (newNumber !== lookupNumber) {
    connection.query('SELECT id FROM invoices WHERE invoice_number = ?', [newNumber], (dupErr, dupRows) => {
      if (dupErr) return res.status(500).json({ error: 'Database error' });
      if (dupRows.length > 0) return res.status(409).json({ error: `Invoice number "${newNumber}" is already in use.` });
      doUpdateInvoice();
    });
  } else {
    doUpdateInvoice();
  }

  function doUpdateInvoice() {
    const upsertClient = 'INSERT INTO clients (name, address) VALUES (?, ?) ON CONFLICT (name) DO UPDATE SET address = EXCLUDED.address';
    connection.query(upsertClient, [customerName, address], (clientErr) => {
      if (clientErr) console.error('Error upserting client:', clientErr);
      const query = `UPDATE invoices SET date = COALESCE(?, date), invoice_number = ?, customer_name = ?, address = ?, items = ?, total_amount = ?, payment_mode = ?, payment_date = ?, transaction_id = ?, status = ? WHERE invoice_number = ?`;
      connection.query(query, [issueDate, newNumber, customerName, address, JSON.stringify(items), totalAmount, payment.paymentMode, payment.paymentDate, payment.transactionId, status || 'pending', lookupNumber], (err) => {
        if (err) { console.error('Update error:', err); return res.status(500).json({ error: 'Failed to update invoice' }); }
        res.json({ success: true, newInvoiceNumber: newNumber });
      });
    });
  }
});

// Update quotation (supports number change via originalQuoteNumber)
app.put('/api/update-quotation', (req, res) => {
  const { quoteNumber, originalQuoteNumber, issueDate: requestedIssueDate, customerName, address, salesperson, paymentTerms, dueDate, items, totalAmount, paymentDetails } = req.body;
  const issueDate = getOptionalIssueDate(requestedIssueDate, res, 'quotation');
  if (issueDate === undefined) return;
  const lookupNumber = originalQuoteNumber || quoteNumber;
  const newNumber = quoteNumber;

  if (newNumber !== lookupNumber) {
    connection.query('SELECT id FROM quotations WHERE quote_number = ?', [newNumber], (dupErr, dupRows) => {
      if (dupErr) return res.status(500).json({ error: 'Database error' });
      if (dupRows.length > 0) return res.status(409).json({ error: `Quote number "${newNumber}" is already in use.` });
      doUpdateQuotation();
    });
  } else {
    doUpdateQuotation();
  }

  function doUpdateQuotation() {
    const upsertClient = 'INSERT INTO clients (name, address) VALUES (?, ?) ON CONFLICT (name) DO UPDATE SET address = EXCLUDED.address';
    connection.query(upsertClient, [customerName, address], (clientErr) => {
      if (clientErr) console.error('Error upserting client:', clientErr);
      const query = `UPDATE quotations SET date = COALESCE(?, date), quote_number = ?, customer_name = ?, address = ?, salesperson = ?, payment_terms = ?, due_date = ?, items = ?, total_amount = ?, payment_details = ? WHERE quote_number = ?`;
      connection.query(query, [issueDate, newNumber, customerName, address, salesperson, paymentTerms, dueDate, JSON.stringify(items), totalAmount, paymentDetails, lookupNumber], (err) => {
        if (err) { console.error('Update error:', err); return res.status(500).json({ error: 'Failed to update quotation' }); }
        res.json({ success: true, newQuoteNumber: newNumber });
      });
    });
  }
});

// Get Dashboard Data
app.get('/api/dashboard', (req, res) => {
  const quotationsQuery = 'SELECT date, quote_number, customer_name, total_amount FROM quotations';
  const invoicesQuery = 'SELECT date, invoice_number, customer_name, total_amount, status FROM invoices';

  connection.query(quotationsQuery, (err, quotations) => {
    if (err) return res.status(500).send('Failed to fetch quotations');
    connection.query(invoicesQuery, (err, invoices) => {
      if (err) return res.status(500).send('Failed to fetch invoices');
      res.json({ quotations, invoices });
    });
  });
});

const EXPENSE_CATEGORIES = [
  'Rent', 'Utilities', 'Travel', 'Software', 'Professional fees',
  'Equipment', 'Supplies', 'Marketing', 'Other'
];

function validateExpenseInput(body, res) {
  const expenseDate = getOptionalIssueDate(body.expenseDate, res, 'expense');
  if (expenseDate === undefined) return null;
  if (!expenseDate) {
    res.status(400).json({ error: 'Expense date is required' });
    return null;
  }
  const supplier = typeof body.supplier === 'string' ? body.supplier.trim() : '';
  const category = typeof body.category === 'string' ? body.category : '';
  const submittedAmount = Number(body.amount);
  const amount = Math.round(submittedAmount * 100) / 100;
  if (!supplier) {
    res.status(400).json({ error: 'Supplier is required' });
    return null;
  }
  if (supplier.length > 160) {
    res.status(400).json({ error: 'Supplier name must be 160 characters or fewer' });
    return null;
  }
  if (!EXPENSE_CATEGORIES.includes(category)) {
    res.status(400).json({ error: 'Choose a valid expense category' });
    return null;
  }
  if (!Number.isFinite(submittedAmount) || amount <= 0 || amount > 999999999999) {
    res.status(400).json({ error: 'Enter an expense amount greater than zero' });
    return null;
  }
  if ((typeof body.description === 'string' && body.description.length > 500) ||
      (typeof body.receiptReference === 'string' && body.receiptReference.length > 120)) {
    res.status(400).json({ error: 'Description or receipt reference is too long' });
    return null;
  }
  if (typeof body.taxDeductible !== 'boolean') {
    res.status(400).json({ error: 'Choose whether this expense is tax deductible' });
    return null;
  }
  return {
    expenseDate,
    supplier,
    category,
    description: typeof body.description === 'string' ? body.description.trim() : '',
    amount,
    taxDeductible: body.taxDeductible,
    receiptReference: typeof body.receiptReference === 'string' ? body.receiptReference.trim() : '',
  };
}

app.get('/api/expenses', requireApiAuth, async (req, res) => {
  try {
    const year = String(req.query.year || new Date().getFullYear());
    let rows;
    if (year === 'all') {
      rows = await queryRows(
        'SELECT id, expense_date, supplier, category, description, amount, tax_deductible, receipt_reference FROM expenses ORDER BY expense_date DESC, id DESC'
      );
    } else {
      const numericYear = Number(year);
      if (!Number.isInteger(numericYear) || numericYear < 2000 || numericYear > 2100) {
        return res.status(400).json({ error: 'Choose a valid year' });
      }
      rows = await queryRows(
        'SELECT id, expense_date, supplier, category, description, amount, tax_deductible, receipt_reference FROM expenses WHERE expense_date >= ?::date AND expense_date < ?::date ORDER BY expense_date DESC, id DESC',
        [`${numericYear}-01-01`, `${numericYear + 1}-01-01`]
      );
    }
    res.json(rows);
  } catch (err) {
    console.error('Expense list error:', err);
    res.status(500).json({ error: 'Failed to load expenses' });
  }
});

app.post('/api/expenses', requireApiAuth, async (req, res) => {
  const expense = validateExpenseInput(req.body, res);
  if (!expense) return;
  try {
    const rows = await queryRows(
      'INSERT INTO expenses (expense_date, supplier, category, description, amount, tax_deductible, receipt_reference) VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING id',
      [expense.expenseDate, expense.supplier, expense.category, expense.description, expense.amount, expense.taxDeductible, expense.receiptReference]
    );
    res.json({ success: true, id: rows[0].id });
  } catch (err) {
    console.error('Expense create error:', err);
    res.status(500).json({ error: 'Failed to save expense' });
  }
});

app.put('/api/expenses/:id', requireApiAuth, async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: 'Invalid expense ID' });
  const expense = validateExpenseInput(req.body, res);
  if (!expense) return;
  try {
    const rows = await queryRows(
      'UPDATE expenses SET expense_date = ?, supplier = ?, category = ?, description = ?, amount = ?, tax_deductible = ?, receipt_reference = ?, updated_at = NOW() WHERE id = ? RETURNING id',
      [expense.expenseDate, expense.supplier, expense.category, expense.description, expense.amount, expense.taxDeductible, expense.receiptReference, id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Expense not found' });
    res.json({ success: true });
  } catch (err) {
    console.error('Expense update error:', err);
    res.status(500).json({ error: 'Failed to update expense' });
  }
});

app.delete('/api/expenses/:id', requireApiAuth, async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: 'Invalid expense ID' });
  try {
    const rows = await queryRows('DELETE FROM expenses WHERE id = ? RETURNING id', [id]);
    if (!rows.length) return res.status(404).json({ error: 'Expense not found' });
    res.json({ success: true });
  } catch (err) {
    console.error('Expense delete error:', err);
    res.status(500).json({ error: 'Failed to delete expense' });
  }
});

app.get('/api/finance-summary', requireApiAuth, async (req, res) => {
  const year = Number(req.query.year || new Date().getFullYear());
  if (!Number.isInteger(year) || year < 2000 || year > 2100) {
    return res.status(400).json({ error: 'Choose a valid year' });
  }
  const start = `${year}-01-01`;
  const end = `${year + 1}-01-01`;
  try {
    const [invoiceRows, expenseRows, categoryRows] = await Promise.all([
      queryRows(
        `SELECT EXTRACT(MONTH FROM date)::integer AS month,
          COALESCE(SUM(total_amount), 0) AS invoiced,
          COALESCE(SUM(CASE WHEN status = 'paid' THEN total_amount ELSE 0 END), 0) AS collected
         FROM invoices WHERE date >= ?::date AND date < ?::date
         GROUP BY EXTRACT(MONTH FROM date) ORDER BY month`,
        [start, end]
      ),
      queryRows(
        `SELECT EXTRACT(MONTH FROM expense_date)::integer AS month,
          COALESCE(SUM(amount), 0) AS total,
          COALESCE(SUM(CASE WHEN tax_deductible THEN amount ELSE 0 END), 0) AS deductible
         FROM expenses WHERE expense_date >= ?::date AND expense_date < ?::date
         GROUP BY EXTRACT(MONTH FROM expense_date) ORDER BY month`,
        [start, end]
      ),
      queryRows(
        `SELECT category, COALESCE(SUM(amount), 0) AS total
         FROM expenses WHERE expense_date >= ?::date AND expense_date < ?::date
         GROUP BY category ORDER BY total DESC`,
        [start, end]
      ),
    ]);
    const months = Array.from({ length: 12 }, (_, index) => ({
      month: index + 1,
      invoiced: 0,
      collected: 0,
      expenses: 0,
      deductibleExpenses: 0,
    }));
    invoiceRows.forEach(row => {
      const month = months[Number(row.month) - 1];
      if (month) {
        month.invoiced = Number(row.invoiced);
        month.collected = Number(row.collected);
      }
    });
    expenseRows.forEach(row => {
      const month = months[Number(row.month) - 1];
      if (month) {
        month.expenses = Number(row.total);
        month.deductibleExpenses = Number(row.deductible);
      }
    });
    const totals = months.reduce((sum, month) => ({
      invoiced: sum.invoiced + month.invoiced,
      collected: sum.collected + month.collected,
      expenses: sum.expenses + month.expenses,
      deductibleExpenses: sum.deductibleExpenses + month.deductibleExpenses,
    }), { invoiced: 0, collected: 0, expenses: 0, deductibleExpenses: 0 });
    res.json({
      year,
      months,
      categories: categoryRows.map(row => ({ category: row.category, total: Number(row.total) })),
      totals: {
        ...totals,
        outstanding: Math.max(0, totals.invoiced - totals.collected),
        estimatedProfit: totals.invoiced - totals.deductibleExpenses,
      },
    });
  } catch (err) {
    console.error('Finance summary error:', err);
    res.status(500).json({ error: 'Failed to load financial summary' });
  }
});

app.get('/api/tax-settings', requireApiAuth, async (req, res) => {
  try {
    const rows = await queryRows('SELECT value FROM app_settings WHERE key = ?', ['tax_estimate_settings']);
    let settings = { ownerSharePercent: 100, years: {} };
    if (rows.length) {
      try {
        settings = { ...settings, ...JSON.parse(rows[0].value || '{}') };
      } catch (parseErr) {
        console.error('Invalid saved tax estimate settings; using defaults');
      }
    }
    const year = String(req.query.year || new Date().getFullYear());
    res.json({
      ownerSharePercent: Number(settings.ownerSharePercent ?? 100),
      year: settings.years?.[year] || { otherTaxableIncome: 0, taxPaid: 0 },
    });
  } catch (err) {
    console.error('Tax settings read error:', err);
    res.status(500).json({ error: 'Failed to load tax settings' });
  }
});

app.post('/api/tax-settings', requireApiAuth, async (req, res) => {
  const { year, ownerSharePercent, otherTaxableIncome, taxPaid } = req.body;
  const numericYear = Number(year);
  const share = Number(ownerSharePercent);
  const otherIncome = Number(otherTaxableIncome);
  const paid = Number(taxPaid);
  if (!Number.isInteger(numericYear) || numericYear < 2000 || numericYear > 2100 ||
      !Number.isFinite(share) || share < 0 || share > 100 ||
      !Number.isFinite(otherIncome) || otherIncome < 0 ||
      !Number.isFinite(paid) || paid < 0) {
    return res.status(400).json({ error: 'Check the year, profit share, income, and tax paid values' });
  }
  try {
    const rows = await queryRows('SELECT value FROM app_settings WHERE key = ?', ['tax_estimate_settings']);
    let settings = { ownerSharePercent: 100, years: {} };
    if (rows.length) {
      try {
        settings = { ...settings, ...JSON.parse(rows[0].value || '{}') };
      } catch (parseErr) {
        console.error('Invalid saved tax estimate settings; replacing with submitted values');
      }
    }
    settings.ownerSharePercent = share;
    settings.years = settings.years || {};
    settings.years[String(numericYear)] = { otherTaxableIncome: otherIncome, taxPaid: paid };
    await queryRows(
      'INSERT INTO app_settings (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value',
      ['tax_estimate_settings', JSON.stringify(settings)]
    );
    res.json({ success: true });
  } catch (err) {
    console.error('Tax settings save error:', err);
    res.status(500).json({ error: 'Failed to save tax settings' });
  }
});

// Import from directory
app.post('/api/import-from-directory', async (req, res) => {
  const { type } = req.body; // 'invoices' or 'quotations'
  const uploadDir = path.join(__dirname, 'uploads', type);
  
  if (!fs.existsSync(uploadDir)) {
    return res.status(404).json({ message: `Directory uploads/${type} not found` });
  }

  const files = fs.readdirSync(uploadDir).filter(f => f.endsWith('.json'));
  let importedCount = 0;
  let skippedCount = 0;

  for (const file of files) {
    try {
      const filePath = path.join(uploadDir, file);
      const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      
      if (type === 'invoices') {
        const { invoiceNumber, customerName, address, items, totalAmount, paymentDetails, status, date } = data;
        
        // Upsert client
        await new Promise((resolve) => {
          const upsertClient = `INSERT INTO clients (name, address) VALUES (?, ?) ON CONFLICT (name) DO UPDATE SET address = EXCLUDED.address`;
          connection.query(upsertClient, [customerName, address], () => resolve());
        });

        // Insert invoice if not exists
        const exists = await new Promise((resolve) => {
          connection.query('SELECT 1 FROM invoices WHERE invoice_number = ?', [invoiceNumber], (err, rows) => {
            resolve(rows && rows.length > 0);
          });
        });

        if (!exists) {
          await new Promise((resolve) => {
            const query = `INSERT INTO invoices (date, invoice_number, customer_name, address, items, total_amount, payment_details, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`;
            connection.query(query, [date || new Date(), invoiceNumber, customerName, address, JSON.stringify(items), totalAmount, paymentDetails, status || 'pending'], () => {
              importedCount++;
              resolve();
            });
          });
        } else {
          skippedCount++;
        }
      } else if (type === 'quotations') {
        const { quoteNumber, customerName, address, salesperson, paymentTerms, dueDate, items, totalAmount, paymentDetails, date } = data;

        // Upsert client
        await new Promise((resolve) => {
          const upsertClient = `INSERT INTO clients (name, address) VALUES (?, ?) ON CONFLICT (name) DO UPDATE SET address = EXCLUDED.address`;
          connection.query(upsertClient, [customerName, address], () => resolve());
        });

        // Insert quotation if not exists
        const exists = await new Promise((resolve) => {
          connection.query('SELECT 1 FROM quotations WHERE quote_number = ?', [quoteNumber], (err, rows) => {
            resolve(rows && rows.length > 0);
          });
        });

        if (!exists) {
          await new Promise((resolve) => {
            const query = `INSERT INTO quotations (date, quote_number, customer_name, address, salesperson, payment_terms, due_date, items, total_amount, payment_details) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;
            connection.query(query, [date || new Date(), quoteNumber, customerName, address, salesperson, paymentTerms, dueDate, JSON.stringify(items), totalAmount, paymentDetails], () => {
              importedCount++;
              resolve();
            });
          });
        } else {
          skippedCount++;
        }
      }
    } catch (err) {
      console.error(`Error processing file ${file}:`, err);
    }
  }

  res.json({ message: 'Import completed', importedCount, skippedCount });
});

// Export Quotation as PDF - FIXED VERSION
app.post('/api/export-quotation-pdf', (req, res) => {
  const { quoteNumber, issueDate, customerName, address, salesperson, paymentTerms, dueDate, items, totalAmount, paymentDetails } = req.body;
  const fileName = `quotation_${quoteNumber}.pdf`;
  const filePath = path.join(__dirname, fileName);

  const doc = new PDFDocument({ size: 'A4', margin: 50 });
  const stream = fs.createWriteStream(filePath);

  stream.on('error', (err) => {
    console.error('Stream Error:', err);
    res.status(500).send('Failed to write PDF file');
  });

  doc.pipe(stream);

  const logoPath = path.join(__dirname, 'public', 'logo.png');
  if (fs.existsSync(logoPath)) {
    doc.image(logoPath, 50, 50, { width: 100 });
  } else {
    console.warn('Logo file not found, skipping logo.');
  }

  // Header content
  doc.fontSize(20).fillColor('#0000FF').text('QUOTATION', 0, 70, { align: 'right', width: 540 });
  doc.fillColor('#000000');
  doc.fontSize(12).text(`Quote Number: ${quoteNumber}`, 0, 100, { align: 'right', width: 540 });
  doc.text(`Date: ${formatDocumentDate(issueDate)}`, 0, 115, { align: 'right', width: 540 });

  // Customer Information
  doc.fontSize(14).text('Customer Information', 50, 200);
  doc.fontSize(12).text(`Name: ${customerName}`, 50, 220);
  doc.text(`Address: ${address}`, 50, 240);
  doc.text(`Salesperson: ${salesperson}`, 50, 260);
  doc.text(`Payment Terms: ${paymentTerms}`, 50, 280);
  doc.text(`Due Date: ${dueDate}`, 50, 300);

  // Items Table with proper cell boundaries
  doc.fontSize(14).text('Items', 50, 340);
  let y = 360;
  const tableTop = y;
  doc.fontSize(10);
  const padding = 5;

  // Define column widths and positions for quotation
  const descCol = { x: 50, width: 260 };
  const qtyCol = { x: 310, width: 50 };
  const priceCol = { x: 360, width: 90 };
  const totalCol = { x: 450, width: 110 };
  const tableWidth = totalCol.x + totalCol.width - descCol.x;

  // Table Header Background (Gray)
  doc.fillColor('#D3D3D3').rect(descCol.x, tableTop, tableWidth, 20).fill();
  doc.fillColor('#000000');
  doc.font('Helvetica-Bold');
  doc.text('Description', descCol.x + padding, y + padding, { width: descCol.width - 2 * padding });
  doc.text('Qty', qtyCol.x + padding, y + padding, { width: qtyCol.width - 2 * padding, align: 'center' });
  doc.text('Unit Price', priceCol.x + padding, y + padding, { width: priceCol.width - 2 * padding, align: 'right' });
  doc.text('Line Total', totalCol.x + padding, y + padding, { width: totalCol.width - 2 * padding, align: 'right' });
  doc.font('Helvetica');
  y += 20;

  // Draw table header borders
  doc.rect(descCol.x, tableTop, tableWidth, 20).stroke();

  // Draw data rows with proper text wrapping
  items.forEach(item => {
    if (y > 700) {
      doc.addPage();
      y = 50;
    }
    
    // Calculate row height based on description text
    const descriptionHeight = doc.heightOfString(item.description || '', { 
      width: descCol.width - 2 * padding 
    });
    const rowHeight = Math.max(25, descriptionHeight + 2 * padding);
    
    // Draw cell backgrounds
    doc.fillColor('#ffffff').rect(descCol.x, y, tableWidth, rowHeight).fill();
    doc.fillColor('#000000');
    
    // Draw text in each cell with proper boundaries
    doc.text(item.description || '', descCol.x + padding, y + padding, { 
      width: descCol.width - 2 * padding,
      height: rowHeight - 2 * padding,
      align: 'left'
    });
    
    doc.text(item.quantity || '', qtyCol.x + padding, y + padding, { 
      width: qtyCol.width - 2 * padding,
      height: rowHeight - 2 * padding,
      align: 'center'
    });
    
    doc.text(item.unitPrice || '', priceCol.x + padding, y + padding, { 
      width: priceCol.width - 2 * padding,
      height: rowHeight - 2 * padding,
      align: 'right'
    });
    
    doc.text(item.lineTotal || '', totalCol.x + padding, y + padding, { 
      width: totalCol.width - 2 * padding,
      height: rowHeight - 2 * padding,
      align: 'right'
    });
    
    // Draw cell borders
    doc.rect(descCol.x, y, descCol.width, rowHeight).stroke();
    doc.rect(qtyCol.x, y, qtyCol.width, rowHeight).stroke();
    doc.rect(priceCol.x, y, priceCol.width, rowHeight).stroke();
    doc.rect(totalCol.x, y, totalCol.width, rowHeight).stroke();
    
    y += rowHeight;
  });

  // Total Amount
  if (y > 720) {
    doc.addPage();
    y = 50;
  }
  doc.fontSize(14).text(`Total Amount: Kshs ${totalAmount}`, 50, y + 20);

  // Payment Details
  y += 40;
  doc.fontSize(12).text('Payment Details:', 50, y);
  y += 20;
  doc.text(paymentDetails || 'CHEQUE NAME: RAMTECHNOLOGIES', 50, y);
  y += 20;

  // Additional Quotation Text
  y += 20;
  if (y > 700) {
    doc.addPage();
    y = 50;
  }
  doc.fontSize(12).text('Quotation prepared by: Ramjius Muhsin A. (Director: RAMTECHNOLOGIES)', 50, y);
  y += 20;
  doc.text('________________________________________________', 50, y);
  y += 20;
  doc.text('This is a quotation on the goods named above and are subject to the conditions noted below:', 50, y);
  y += 20;
  doc.fontSize(14).text('TERMS AND CONDITIONS', 50, y);
  y += 20;
  doc.fontSize(12).text('The above cost is for sale of the Software product, materials, implementation and user training.', 50, y, { width: 500 });
  y += 40;
  doc.text('____________________________________________________________________________________________________________________________', 50, y);
  y += 20;
  doc.text('If you agree to the above terms please write us an email indicating so, at ramtechnologiesltd@gmail.com', 50, y);
  y += 15;
  doc.text('Or call us on +254727310226.', 50, y);
  y += 20;
  doc.text('Thank you for your business, be blessed.', 50, y);

  // Signature Section
  y += 40;
  if (y > 680) {
    doc.addPage();
    y = 50;
  }
  doc.fontSize(12).text('Yours Faithfully', 50, y);
  y += 20;
  const signaturePath = path.join(__dirname, 'public', 'signature.png');
  if (fs.existsSync(signaturePath)) {
    doc.image(signaturePath, 50, y, { width: 100 });
    y += 60;
  } else {
    console.warn('Signature file not found, skipping signature.');
    y += 40;
  }
  doc.text('Ramjius Muhsin,', 50, y);
  y += 15;
  doc.text('Director,', 50, y);
  y += 15;
  doc.text('Ramtechnologies', 50, y);

  doc.end();

  stream.on('finish', () => {
    if (fs.existsSync(filePath) && fs.statSync(filePath).size > 0) {
      res.download(filePath, fileName, (err) => {
        if (err) {
          console.error('Error sending PDF:', err);
          res.status(500).send('Failed to export PDF');
        }
        fs.unlink(filePath, (err) => {
          if (err) console.error('Error deleting PDF:', err);
        });
      });
    } else {
      console.error('PDF file is empty or not created');
      res.status(500).send('Failed to generate PDF');
    }
  });
});

// Export Invoice as PDF - FIXED VERSION
app.post('/api/export-invoice-pdf', (req, res) => {
  const { invoiceNumber, issueDate, customerName, address, items, totalAmount, status, paymentMode, paymentDate, transactionId } = req.body;
  const fileName = `${invoiceNumber}-${customerName}.pdf`;
  const filePath = path.join(__dirname, fileName);

  const doc = new PDFDocument();
  const stream = fs.createWriteStream(filePath);

  stream.on('error', (err) => {
    console.error('Stream Error:', err);
    res.status(500).send('Failed to write PDF file');
  });

  doc.pipe(stream);

  const logoPath = path.join(__dirname, 'public', 'logo.png');
  if (fs.existsSync(logoPath)) {
    doc.image(logoPath, 50, 50, { width: 100 });
  } else {
    console.warn('Logo file not found, skipping logo.');
  }

  // Header content with Color and Capitalized Status
  doc.fontSize(20).fillColor('#0000FF').text('INVOICE', 0, 70, { align: 'right', width: 540 });
  doc.fillColor('#000000');
  doc.fontSize(12).text(`Invoice Number: ${invoiceNumber}`, 0, 100, { align: 'right', width: 540 });
  doc.text(`Date: ${formatDocumentDate(issueDate)}`, 0, 115, { align: 'right', width: 540 });
  doc.fillColor(status && status.toUpperCase() === 'PAID' ? '#008000' : '#FF0000');
  doc.text(`Status: ${(status || 'Pending').toUpperCase()}`, 0, 130, { align: 'right', width: 540 });
  doc.fillColor('#000000');

  // Customer Information
  doc.fontSize(14).text('Customer Information', 50, 200);
  doc.fontSize(12).text(`Name: ${customerName}`, 50, 220);
  doc.text(`Address: ${address}`, 50, 240);

  // Items Table with proper cell boundaries
  doc.fontSize(14).text('Items', 50, 300);
  let y = 330;
  const tableTop = y;
  doc.fontSize(10);
  const padding = 5;
  
  // Define column widths and positions
  const descCol = { x: 50, width: 200 };
  const qtyCol = { x: 250, width: 60 };
  const priceCol = { x: 310, width: 90 };
  const totalCol = { x: 400, width: 100 };
  const tableWidth = totalCol.x + totalCol.width - descCol.x;

  // Table Header Background (Gray)
  doc.fillColor('#D3D3D3').rect(descCol.x, tableTop, tableWidth, 20).fill();
  doc.fillColor('#000000');
  doc.font('Helvetica-Bold');
  doc.text('Description', descCol.x + padding, y + padding, { width: descCol.width - 2 * padding });
  doc.text('Quantity', qtyCol.x + padding, y + padding, { width: qtyCol.width - 2 * padding, align: 'center' });
  doc.text('Unit Price', priceCol.x + padding, y + padding, { width: priceCol.width - 2 * padding, align: 'right' });
  doc.text('Line Total', totalCol.x + padding, y + padding, { width: totalCol.width - 2 * padding, align: 'right' });
  doc.font('Helvetica');
  y += 20;

  // Draw table header borders
  doc.rect(descCol.x, tableTop, tableWidth, 20).stroke();

  // Draw data rows with proper text wrapping
  items.forEach(item => {
    if (y > 700) {
      doc.addPage();
      y = 50;
    }
    
    // Calculate row height based on description text
    const descriptionHeight = doc.heightOfString(item.description || '', { 
      width: descCol.width - 2 * padding 
    });
    const rowHeight = Math.max(25, descriptionHeight + 2 * padding);
    
    // Draw cell backgrounds (alternating colors can be added here)
    doc.fillColor('#ffffff').rect(descCol.x, y, tableWidth, rowHeight).fill();
    doc.fillColor('#000000');
    
    // Draw text in each cell with proper boundaries
    doc.text(item.description || '', descCol.x + padding, y + padding, { 
      width: descCol.width - 2 * padding,
      height: rowHeight - 2 * padding,
      align: 'left'
    });
    
    doc.text(item.quantity || '', qtyCol.x + padding, y + padding, { 
      width: qtyCol.width - 2 * padding,
      height: rowHeight - 2 * padding,
      align: 'center'
    });
    
    doc.text(item.unitPrice || '', priceCol.x + padding, y + padding, { 
      width: priceCol.width - 2 * padding,
      height: rowHeight - 2 * padding,
      align: 'right'
    });
    
    doc.text(item.lineTotal || '', totalCol.x + padding, y + padding, { 
      width: totalCol.width - 2 * padding,
      height: rowHeight - 2 * padding,
      align: 'right'
    });
    
    // Draw cell borders
    doc.rect(descCol.x, y, descCol.width, rowHeight).stroke();
    doc.rect(qtyCol.x, y, qtyCol.width, rowHeight).stroke();
    doc.rect(priceCol.x, y, priceCol.width, rowHeight).stroke();
    doc.rect(totalCol.x, y, totalCol.width, rowHeight).stroke();
    
    y += rowHeight;
  });

  // Total Amount
  doc.fontSize(14).text(`Total Amount: Kshs ${totalAmount}`, 50, y + 20);

  // Payment information and Closing Text
  y += 60;
  doc.fontSize(12).text('Payment Mode:', 50, y);
  y += 20;
  doc.text(paymentMode || 'CHEQUE', 50, y);
  y += 20;
  if (status === 'paid') {
    doc.text(`Payment Date: ${paymentDate || ''}`, 50, y);
    y += 20;
    doc.text(`Transaction ID: ${transactionId || ''}`, 50, y);
    y += 20;
  }
  doc.text('We trust that we have addressed your requirements favorably and look forward to a continued healthy business relationship.', 50, y, { width: 500 });
  y += 40;
  doc.text('Yours Faithfully', 50, y);
  y += 20;

  // Add Signature Image
  const signaturePath = path.join(__dirname, 'public', 'signature.png');
  if (fs.existsSync(signaturePath)) {
    doc.image(signaturePath, 50, y, { width: 100 });
    y += 60;
  } else {
    console.warn('Signature file not found, skipping signature.');
    y += 40;
  }

  doc.text('Ramjius Muhsin,', 50, y);
  y += 15;
  doc.text('Director,', 50, y);
  y += 15;
  doc.text('Ramtechnologies', 50, y);

  doc.end();

  stream.on('finish', () => {
    if (fs.existsSync(filePath) && fs.statSync(filePath).size > 0) {
      res.download(filePath, fileName, (err) => {
        if (err) {
          console.error('Error sending PDF:', err);
          res.status(500).send('Failed to export PDF');
        }
        fs.unlink(filePath, (err) => {
          if (err) console.error('Error deleting PDF:', err);
        });
      });
    } else {
      console.error('PDF file is empty or not created');
      res.status(500).send('Failed to generate PDF');
    }
  });
});

// Reprint Invoice - FIXED VERSION
app.get('/api/reprint-invoice/:invoiceNumber', (req, res) => {
  const { invoiceNumber } = req.params;

  const query = `SELECT * FROM invoices WHERE invoice_number = ?`;
  connection.query(query, [invoiceNumber], (err, results) => {
    if (err) {
      console.error('Database Error:', err);
      return res.status(500).send('Failed to fetch invoice');
    }
    if (results.length === 0) {
      return res.status(404).send('Invoice not found');
    }

    const invoice = results[0];
    let items = [];
    if (typeof invoice.items === 'string') {
      try {
        items = JSON.parse(invoice.items);
      } catch (parseErr) {
        console.error(`Error parsing items for invoice ${invoiceNumber}:`, parseErr);
        console.error('Raw items data:', invoice.items);
        items = []; // Fallback to empty array if parsing fails
      }
    } else if (Array.isArray(invoice.items)) {
      items = invoice.items; // Use directly if already an array
    } else {
      console.error('Unexpected items format for invoice', invoiceNumber, ':', invoice.items);
      items = []; // Fallback for unexpected format
    }

    const fileName = `${invoiceNumber}-${invoice.customer_name}.pdf`;
    const filePath = path.join(__dirname, fileName);
    const doc = new PDFDocument();
    const stream = fs.createWriteStream(filePath);

    doc.pipe(stream);

    const logoPath = path.join(__dirname, 'public', 'logo.png');
    if (fs.existsSync(logoPath)) {
      doc.image(logoPath, 50, 50, { width: 100 });
    }

    // Header content with Color and Capitalized Status
    doc.fontSize(20).fillColor('#0000FF').text('INVOICE', 0, 70, { align: 'right', width: 540 });
    doc.fillColor('#000000');
    doc.fontSize(12).text(`Invoice Number: ${invoiceNumber}`, 0, 100, { align: 'right', width: 540 });
    doc.text(`Date: ${new Date(invoice.date).toLocaleDateString()}`, 0, 115, { align: 'right', width: 540 });
    doc.fillColor(invoice.status && invoice.status.toUpperCase() === 'PAID' ? '#008000' : '#FF0000');
    doc.text(`Status: ${(invoice.status || 'Pending').toUpperCase()}`, 0, 130, { align: 'right', width: 540 });
    doc.fillColor('#000000');

    // Customer Information
    doc.fontSize(14).text('Customer Information', 50, 200);
    doc.fontSize(12).text(`Name: ${invoice.customer_name}`, 50, 220);
    doc.text(`Address: ${invoice.address}`, 50, 240);

    // Items Table with proper cell boundaries
    doc.fontSize(14).text('Items', 50, 300);
    let y = 330;
    const tableTop = y;
    doc.fontSize(10);
    const padding = 5;
    
    // Define column widths and positions
    const descCol = { x: 50, width: 200 };
    const qtyCol = { x: 250, width: 60 };
    const priceCol = { x: 310, width: 90 };
    const totalCol = { x: 400, width: 100 };
    const tableWidth = totalCol.x + totalCol.width - descCol.x;

    // Table Header Background (Gray)
    doc.fillColor('#D3D3D3').rect(descCol.x, tableTop, tableWidth, 20).fill();
    doc.fillColor('#000000');
    doc.font('Helvetica-Bold');
    doc.text('Description', descCol.x + padding, y + padding, { width: descCol.width - 2 * padding });
    doc.text('Quantity', qtyCol.x + padding, y + padding, { width: qtyCol.width - 2 * padding, align: 'center' });
    doc.text('Unit Price', priceCol.x + padding, y + padding, { width: priceCol.width - 2 * padding, align: 'right' });
    doc.text('Line Total', totalCol.x + padding, y + padding, { width: totalCol.width - 2 * padding, align: 'right' });
    doc.font('Helvetica');
    y += 20;

    // Draw table header borders
    doc.rect(descCol.x, tableTop, tableWidth, 20).stroke();

    // Draw data rows with proper text wrapping
    items.forEach(item => {
      if (y > 700) {
        doc.addPage();
        y = 50;
      }
      
      // Calculate row height based on description text
      const descriptionHeight = doc.heightOfString(item.description || '', { 
        width: descCol.width - 2 * padding 
      });
      const rowHeight = Math.max(25, descriptionHeight + 2 * padding);
      
      // Draw cell backgrounds
      doc.fillColor('#ffffff').rect(descCol.x, y, tableWidth, rowHeight).fill();
      doc.fillColor('#000000');
      
      // Draw text in each cell with proper boundaries
      doc.text(item.description || '', descCol.x + padding, y + padding, { 
        width: descCol.width - 2 * padding,
        height: rowHeight - 2 * padding,
        align: 'left'
      });
      
      doc.text(item.quantity || '', qtyCol.x + padding, y + padding, { 
        width: qtyCol.width - 2 * padding,
        height: rowHeight - 2 * padding,
        align: 'center'
      });
      
      doc.text(item.unitPrice || '', priceCol.x + padding, y + padding, { 
        width: priceCol.width - 2 * padding,
        height: rowHeight - 2 * padding,
        align: 'right'
      });
      
      doc.text(item.lineTotal || '', totalCol.x + padding, y + padding, { 
        width: totalCol.width - 2 * padding,
        height: rowHeight - 2 * padding,
        align: 'right'
      });
      
      // Draw cell borders
      doc.rect(descCol.x, y, descCol.width, rowHeight).stroke();
      doc.rect(qtyCol.x, y, qtyCol.width, rowHeight).stroke();
      doc.rect(priceCol.x, y, priceCol.width, rowHeight).stroke();
      doc.rect(totalCol.x, y, totalCol.width, rowHeight).stroke();
      
      y += rowHeight;
    });

    // Total Amount
    doc.fontSize(14).text(`Total Amount: Kshs ${invoice.total_amount}`, 50, y + 20);

  // Payment information and Closing Text with Signature Image
  y += 80; // Additional space before payment details
  doc.fontSize(12).text('Payment Mode:', 50, y);
  y += 20;
  doc.text(invoice.payment_mode || 'CHEQUE', 50, y);
  y += 20;
  if (invoice.status === 'paid') {
    doc.text(`Payment Date: ${invoice.payment_date ? String(invoice.payment_date).slice(0, 10) : ''}`, 50, y);
    y += 20;
    doc.text(`Transaction ID: ${invoice.transaction_id || ''}`, 50, y);
    y += 20;
  }
    doc.text('We trust that we have addressed your requirements favorably and look forward to a continued healthy business relationship.', 50, y, { width: 500 });
    y += 40;
    doc.text('Yours Faithfully', 50, y);
    y += 20; // Space before signature

    // Add Signature Image
    const signaturePath = path.join(__dirname, 'public', 'signature.png');
    if (fs.existsSync(signaturePath)) {
      doc.image(signaturePath, 50, y, { width: 100 }); // Adjust width as needed
      y += 60; // Adjust based on signature height
    } else {
      console.warn('Signature file not found, skipping signature.');
      y += 40; // Fallback spacing if no signature
    }

    doc.text('Ramjius Muhsin,', 50, y);
    y += 15;
    doc.text('Director,', 50, y);
    y += 15;
    doc.text('Ramtechnologies', 50, y);

    doc.end();

    stream.on('finish', () => {
      res.download(filePath, fileName, (err) => {
        if (err) {
          console.error('Error sending PDF:', err);
          res.status(500).send('Failed to export PDF');
        }
        fs.unlink(filePath, (err) => {
          if (err) console.error('Error deleting PDF:', err);
        });
      });
    });
  });
});

// Reprint Quotation - FIXED VERSION
app.get('/api/reprint-quotation/:quoteNumber', (req, res) => {
  const { quoteNumber } = req.params;

  const query = `SELECT * FROM quotations WHERE quote_number = ?`;
  connection.query(query, [quoteNumber], (err, results) => {
    if (err) {
      console.error('Database Error:', err);
      return res.status(500).send('Failed to fetch quotation');
    }
    if (results.length === 0) {
      return res.status(404).send('Quotation not found');
    }

    const quotation = results[0];
    let items = [];
    if (typeof quotation.items === 'string') {
      try {
        items = JSON.parse(quotation.items);
      } catch (parseErr) {
        console.error(`Error parsing items for quote ${quoteNumber}:`, parseErr);
        items = [];
      }
    } else if (Array.isArray(quotation.items)) {
      items = quotation.items;
    }

    const fileName = `quotation_${quoteNumber}.pdf`;
    const filePath = path.join(__dirname, fileName);
    const doc = new PDFDocument({ size: 'A4', margin: 50 });
    const stream = fs.createWriteStream(filePath);

    doc.pipe(stream);

    const logoPath = path.join(__dirname, 'public', 'logo.png');
    if (fs.existsSync(logoPath)) {
      doc.image(logoPath, 50, 50, { width: 100 });
    }

    // Header content
    doc.fontSize(20).fillColor('#0000FF').text('QUOTATION', 0, 70, { align: 'right', width: 540 });
    doc.fillColor('#000000');
    doc.fontSize(12).text(`Quote Number: ${quoteNumber}`, 0, 100, { align: 'right', width: 540 });
    doc.text(`Date: ${new Date(quotation.date).toLocaleDateString()}`, 0, 115, { align: 'right', width: 540 });

    // Customer Information
    doc.fontSize(14).text('Customer Information', 50, 200);
    doc.fontSize(12).text(`Name: ${quotation.customer_name}`, 50, 220);
    doc.text(`Address: ${quotation.address}`, 50, 240);
    doc.text(`Salesperson: ${quotation.salesperson}`, 50, 260);
    doc.text(`Payment Terms: ${quotation.payment_terms}`, 50, 280);
    doc.text(`Due Date: ${quotation.due_date}`, 50, 300);

    // Items Table with proper cell boundaries
    doc.fontSize(14).text('Items', 50, 340);
    let y = 360;
    const tableTop = y;
    doc.fontSize(10);
    const padding = 5;

    // Define column widths and positions for quotation
    const descCol = { x: 50, width: 260 };
    const qtyCol = { x: 310, width: 50 };
    const priceCol = { x: 360, width: 90 };
    const totalCol = { x: 450, width: 110 };
    const tableWidth = totalCol.x + totalCol.width - descCol.x;

    // Table Header Background (Gray)
    doc.fillColor('#D3D3D3').rect(descCol.x, tableTop, tableWidth, 20).fill();
    doc.fillColor('#000000');
    doc.font('Helvetica-Bold');
    doc.text('Description', descCol.x + padding, y + padding, { width: descCol.width - 2 * padding });
    doc.text('Qty', qtyCol.x + padding, y + padding, { width: qtyCol.width - 2 * padding, align: 'center' });
    doc.text('Unit Price', priceCol.x + padding, y + padding, { width: priceCol.width - 2 * padding, align: 'right' });
    doc.text('Line Total', totalCol.x + padding, y + padding, { width: totalCol.width - 2 * padding, align: 'right' });
    doc.font('Helvetica');
    y += 20;

    // Draw table header borders
    doc.rect(descCol.x, tableTop, tableWidth, 20).stroke();

    // Draw data rows with proper text wrapping
    items.forEach(item => {
      if (y > 700) {
        doc.addPage();
        y = 50;
      }
      
      // Calculate row height based on description text
      const descriptionHeight = doc.heightOfString(item.description || '', { 
        width: descCol.width - 2 * padding 
      });
      const rowHeight = Math.max(25, descriptionHeight + 2 * padding);
      
      // Draw cell backgrounds
      doc.fillColor('#ffffff').rect(descCol.x, y, tableWidth, rowHeight).fill();
      doc.fillColor('#000000');
      
      // Draw text in each cell with proper boundaries
      doc.text(item.description || '', descCol.x + padding, y + padding, { 
        width: descCol.width - 2 * padding,
        height: rowHeight - 2 * padding,
        align: 'left'
      });
      
      doc.text(item.quantity || '', qtyCol.x + padding, y + padding, { 
        width: qtyCol.width - 2 * padding,
        height: rowHeight - 2 * padding,
        align: 'center'
      });
      
      doc.text(item.unitPrice || '', priceCol.x + padding, y + padding, { 
        width: priceCol.width - 2 * padding,
        height: rowHeight - 2 * padding,
        align: 'right'
      });
      
      doc.text(item.lineTotal || '', totalCol.x + padding, y + padding, { 
        width: totalCol.width - 2 * padding,
        height: rowHeight - 2 * padding,
        align: 'right'
      });
      
      // Draw cell borders
      doc.rect(descCol.x, y, descCol.width, rowHeight).stroke();
      doc.rect(qtyCol.x, y, qtyCol.width, rowHeight).stroke();
      doc.rect(priceCol.x, y, priceCol.width, rowHeight).stroke();
      doc.rect(totalCol.x, y, totalCol.width, rowHeight).stroke();
      
      y += rowHeight;
    });

    // Total Amount
    if (y > 720) {
      doc.addPage();
      y = 50;
    }
    doc.fontSize(14).text(`Total Amount: Kshs ${quotation.total_amount}`, 50, y + 20);

    // Payment Details
    y += 40;
    doc.fontSize(12).text('Payment Details:', 50, y);
    y += 20;
    doc.text(quotation.payment_details || 'CHEQUE NAME: RAMTECHNOLOGIES', 50, y);
    y += 20;

    // Additional Quotation Text
    y += 20;
    if (y > 700) {
      doc.addPage();
      y = 50;
    }
    doc.fontSize(12).text('Quotation prepared by: Ramjius Muhsin A. (Director: RAMTECHNOLOGIES)', 50, y);
    y += 20;
    doc.text('______________________________________________________________', 50, y);
    y += 20;
    doc.text('This is a quotation on the goods named above and are subject to the conditions noted below:', 50, y);
    y += 20;
    doc.fontSize(14).text('TERMS AND CONDITIONS', 50, y);
    y += 20;
    doc.fontSize(12).text('The above cost is for materials and labor.', 50, y, { width: 500 });
    y += 20;
    doc.text('_______________________________________________________________', 50, y);
    y += 20;
    doc.text('If you agree to the above terms please write us an email indicating so, at ramtechnologiesltd@gmail.com Or call us on +254727310226.', 50, y);
    y += 40;
    doc.text('Thank you for your business, be blessed.', 50, y);

    // Signature Section (Invoice Style)
    y += 40;
    if (y > 680) {
      doc.addPage();
      y = 50;
    }
    doc.fontSize(12).text('Yours Faithfully', 50, y);
    y += 20;
    const signaturePath = path.join(__dirname, 'public', 'signature.png');
    if (fs.existsSync(signaturePath)) {
      doc.image(signaturePath, 50, y, { width: 100 });
      y += 60;
    } else {
      console.warn('Signature file not found, skipping signature.');
      y += 40;
    }
    doc.text('Ramjius Muhsin,', 50, y);
    y += 15;
    doc.text('Director,', 50, y);
    y += 15;
    doc.text('Ramtechnologies', 50, y);

    doc.end();

    stream.on('finish', () => {
      res.download(filePath, fileName, (err) => {
        if (err) {
          console.error('Error sending PDF:', err);
          res.status(500).send('Failed to export PDF');
        }
        fs.unlink(filePath, (err) => {
          if (err) console.error('Error deleting PDF:', err);
        });
      });
    });
  });
});

// ─── SETTINGS-AWARE INVOICE NUMBER GENERATION ───────────────────────────────

app.get('/api/next-invoice-number', async (req, res) => {
  try {
    const s = await getSettings();
    const prefix = s.invoice_prefix || '';
    const suffix = s.invoice_suffix || '';
    const padding = parseInt(s.invoice_number_padding) || 2;
    const useYear = s.invoice_number_use_year !== 'false';
    const currentYear = new Date().getFullYear().toString();
    const yearPart = useYear ? currentYear : '';

    // Pattern to search existing numbers
    const searchPattern = `${prefix}${yearPart}%`;
    connection.query(
      'SELECT invoice_number FROM invoices WHERE invoice_number LIKE ? ORDER BY id DESC LIMIT 1',
      [searchPattern],
      (err, results) => {
        if (err) return res.status(500).json({ error: 'DB error' });
        let seq = parseInt(s.invoice_start_number) || 1;
        if (results.length > 0) {
          // Strip prefix, year, suffix; parse remaining integer
          let raw = results[0].invoice_number;
          raw = raw.replace(prefix, '').replace(suffix, '');
          if (useYear) raw = raw.replace(currentYear, '');
          const parsed = parseInt(raw);
          if (!isNaN(parsed)) seq = parsed + 1;
        }
        const seqStr = seq.toString().padStart(padding, '0');
        res.json({ invoiceNumber: `${prefix}${yearPart}${seqStr}${suffix}` });
      }
    );
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/next-quotation-number', async (req, res) => {
  try {
    const s = await getSettings();
    const prefix = s.quotation_prefix || '';
    const suffix = s.quotation_suffix || '';
    const padding = parseInt(s.quotation_number_padding) || 2;
    const useYear = s.quotation_number_use_year !== 'false';
    const currentYear = new Date().getFullYear().toString();
    const yearPart = useYear ? currentYear : '';

    const searchPattern = `${prefix}${yearPart}%`;
    connection.query(
      'SELECT quote_number FROM quotations WHERE quote_number LIKE ? ORDER BY id DESC LIMIT 1',
      [searchPattern],
      (err, results) => {
        if (err) return res.status(500).json({ error: 'DB error' });
        let seq = parseInt(s.quotation_start_number) || 1;
        if (results.length > 0) {
          let raw = results[0].quote_number;
          raw = raw.replace(prefix, '').replace(suffix, '');
          if (useYear) raw = raw.replace(currentYear, '');
          const parsed = parseInt(raw);
          if (!isNaN(parsed)) seq = parsed + 1;
        }
        const seqStr = seq.toString().padStart(padding, '0');
        res.json({ quoteNumber: `${prefix}${yearPart}${seqStr}${suffix}` });
      }
    );
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── SETTINGS API ─────────────────────────────────────────────────────────────

app.get('/api/settings', requireAuth, async (req, res) => {
  try {
    const s = await getSettings();
    res.json(s);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/settings', requireAuth, async (req, res) => {
  try {
    const updates = req.body; // { key: value, ... }
    for (const [key, value] of Object.entries(updates)) {
      await new Promise((resolve, reject) => {
        connection.query(
          'INSERT INTO app_settings (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = ?',
          [key, value, value],
          (err) => err ? reject(err) : resolve()
        );
      });
    }
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Reset invoice sequence (update start number)
app.post('/api/settings/reset-invoice-sequence', requireAuth, async (req, res) => {
  try {
    const { startNumber } = req.body;
    await new Promise((resolve, reject) => {
      connection.query(
        'INSERT INTO app_settings (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = ?',
        ['invoice_start_number', String(startNumber || 1), String(startNumber || 1)],
        (err) => err ? reject(err) : resolve()
      );
    });
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/settings/reset-quotation-sequence', requireAuth, async (req, res) => {
  try {
    const { startNumber } = req.body;
    await new Promise((resolve, reject) => {
      connection.query(
        'INSERT INTO app_settings (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = ?',
        ['quotation_start_number', String(startNumber || 1), String(startNumber || 1)],
        (err) => err ? reject(err) : resolve()
      );
    });
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── FILE UPLOAD ──────────────────────────────────────────────────────────────

app.post('/api/upload-logo', requireAuth, upload.single('logo'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
  // Rename to logo.png regardless of original extension
  const dest = path.join(__dirname, 'public', 'logo.png');
  if (req.file.path !== dest) {
    fs.renameSync(req.file.path, dest);
  }
  res.json({ success: true, filename: 'logo.png' });
});

app.post('/api/upload-signature', requireAuth, upload.single('signature'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
  const dest = path.join(__dirname, 'public', 'signature.png');
  if (req.file.path !== dest) {
    fs.renameSync(req.file.path, dest);
  }
  res.json({ success: true, filename: 'signature.png' });
});

// ─── AUTH ROUTES ──────────────────────────────────────────────────────────────

// Check if any user exists
app.get('/api/auth/has-users', (req, res) => {
  connection.query('SELECT COUNT(*) as cnt FROM users', (err, rows) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json({ hasUsers: parseInt(rows[0].cnt) > 0 });
  });
});

// Sign up
app.post('/api/auth/signup', async (req, res) => {
  try {
    const { username, email, password } = req.body;
    if (!username || !email || !password) {
      return res.status(400).json({ error: 'All fields are required' });
    }
    // Only allow first user signup freely; subsequent require login
    const countResult = await new Promise((resolve, reject) => {
      connection.query('SELECT COUNT(*) as cnt FROM users', (err, rows) => {
        err ? reject(err) : resolve(rows);
      });
    });
    const count = parseInt(countResult[0].cnt);
    if (count > 0 && !(req.session && req.session.userId)) {
      return res.status(403).json({ error: 'Only the first admin account can be created without login' });
    }
    const hash = await bcrypt.hash(password, 12);
    await new Promise((resolve, reject) => {
      connection.query(
        'INSERT INTO users (username, email, password_hash) VALUES (?, ?, ?)',
        [username, email, hash],
        (err) => err ? reject(err) : resolve()
      );
    });
    res.json({ success: true });
  } catch (e) {
    if (e.code === '23505') return res.status(400).json({ error: 'Username or email already exists' });
    res.status(500).json({ error: e.message });
  }
});

// Login
app.post('/api/auth/login', async (req, res) => {
  try {
    const { username, password } = req.body;
    if (!username || !password) return res.status(400).json({ error: 'All fields required' });
    const rows = await new Promise((resolve, reject) => {
      connection.query('SELECT * FROM users WHERE username = ? OR email = ?', [username, username], (err, r) => {
        err ? reject(err) : resolve(r);
      });
    });
    if (!rows.length) return res.status(401).json({ error: 'Invalid credentials' });
    const user = rows[0];
    const match = await bcrypt.compare(password, user.password_hash);
    if (!match) return res.status(401).json({ error: 'Invalid credentials' });
    req.session.userId = user.id;
    req.session.username = user.username;
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Logout
app.post('/api/auth/logout', (req, res) => {
  req.session.destroy();
  res.json({ success: true });
});

// List all users (admin only)
app.get('/api/auth/users', requireAuth, (req, res) => {
  connection.query('SELECT id, username, email, created_at FROM users ORDER BY id', (err, rows) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json(rows);
  });
});

// Change password
app.post('/api/auth/change-password', requireAuth, async (req, res) => {
  try {
    const { currentPwd, newPwd } = req.body;
    if (!currentPwd || !newPwd) return res.status(400).json({ error: 'Missing fields' });
    const rows = await new Promise((resolve, reject) => {
      connection.query('SELECT * FROM users WHERE id = ?', [req.session.userId], (err, r) => {
        err ? reject(err) : resolve(r);
      });
    });
    if (!rows.length) return res.status(404).json({ error: 'User not found' });
    const match = await bcrypt.compare(currentPwd, rows[0].password_hash);
    if (!match) return res.status(401).json({ error: 'Current password is incorrect' });
    const hash = await bcrypt.hash(newPwd, 12);
    await new Promise((resolve, reject) => {
      connection.query('UPDATE users SET password_hash = ? WHERE id = ?', [hash, req.session.userId], (err) => {
        err ? reject(err) : resolve();
      });
    });
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── PASSWORD RESET ROUTES ────────────────────────────────────────────────────

// POST /api/auth/forgot-password — generate token and send email
app.post('/api/auth/forgot-password', async (req, res) => {
  try {
    const { email } = req.body;
    if (!email) return res.status(400).json({ error: 'Email is required' });

    const rows = await new Promise((resolve, reject) => {
      connection.query('SELECT * FROM users WHERE email = ?', [email.trim().toLowerCase()], (err, r) => {
        err ? reject(err) : resolve(r);
      });
    });

    // Always respond with success to prevent email enumeration
    if (!rows.length) return res.json({ success: true });

    const user = rows[0];
    const token = crypto.randomBytes(32).toString('hex');
    const expiresAt = new Date(Date.now() + 60 * 60 * 1000); // 1 hour

    // Invalidate any existing tokens for this user
    await pool.query('DELETE FROM password_reset_tokens WHERE user_id = $1', [user.id]);

    await pool.query(
      'INSERT INTO password_reset_tokens (user_id, token, expires_at) VALUES ($1, $2, $3)',
      [user.id, token, expiresAt]
    );

    const transporter = createMailTransporter();
    if (!transporter) {
      console.warn('SMTP not configured — password reset token:', token);
      return res.json({ success: true });
    }

    const resetUrl = `${BASE_URL}/reset-password?token=${token}`;
    const fromAddr = process.env.SMTP_FROM || process.env.SMTP_USER;

    await transporter.sendMail({
      from: `"Ramtechnologies" <${fromAddr}>`,
      to: email,
      subject: 'Reset your password',
      html: `
        <div style="font-family:Arial,sans-serif;max-width:480px;margin:0 auto;padding:32px;background:#f8f8f8;border-radius:8px;">
          <h2 style="color:#212121;margin-top:0;">Reset your password</h2>
          <p style="color:#555;">Hi ${user.username || ''},</p>
          <p style="color:#555;">We received a request to reset the password for your Ramtechnologies account. Click the button below to set a new password. This link expires in <strong>1 hour</strong>.</p>
          <a href="${resetUrl}" style="display:inline-block;margin:20px 0;padding:12px 28px;background:#212121;color:white;border-radius:6px;text-decoration:none;font-weight:bold;font-size:15px;">Reset Password</a>
          <p style="color:#999;font-size:12px;">If you didn't request this, you can safely ignore this email — your password will not change.</p>
          <p style="color:#ccc;font-size:11px;">Link: ${resetUrl}</p>
        </div>
      `,
    });

    res.json({ success: true });
  } catch (e) {
    console.error('Forgot password error:', e);
    res.status(500).json({ error: 'Failed to send reset email. Please try again.' });
  }
});

// GET /api/auth/validate-reset-token — check token validity
app.get('/api/auth/validate-reset-token', async (req, res) => {
  try {
    const { token } = req.query;
    if (!token) return res.status(400).json({ valid: false, error: 'No token provided' });

    const result = await pool.query(
      'SELECT * FROM password_reset_tokens WHERE token = $1 AND used = FALSE AND expires_at > NOW()',
      [token]
    );

    if (!result.rows.length) {
      return res.status(400).json({ valid: false, error: 'This reset link is invalid or has expired.' });
    }
    res.json({ valid: true });
  } catch (e) {
    res.status(500).json({ valid: false, error: 'Server error' });
  }
});

// POST /api/auth/reset-password — apply new password
app.post('/api/auth/reset-password', async (req, res) => {
  try {
    const { token, newPassword } = req.body;
    if (!token || !newPassword) return res.status(400).json({ error: 'Token and new password are required' });
    if (newPassword.length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters' });

    const tokenResult = await pool.query(
      'SELECT * FROM password_reset_tokens WHERE token = $1 AND used = FALSE AND expires_at > NOW()',
      [token]
    );

    if (!tokenResult.rows.length) {
      return res.status(400).json({ error: 'This reset link is invalid or has expired.' });
    }

    const { user_id, id: tokenId } = tokenResult.rows[0];
    const hash = await bcrypt.hash(newPassword, 12);

    await pool.query('UPDATE users SET password_hash = $1 WHERE id = $2', [hash, user_id]);
    await pool.query('UPDATE password_reset_tokens SET used = TRUE WHERE id = $1', [tokenId]);

    res.json({ success: true });
  } catch (e) {
    console.error('Reset password error:', e);
    res.status(500).json({ error: 'Failed to reset password. Please try again.' });
  }
});

// Check session
app.get('/api/auth/me', (req, res) => {
  if (req.session && req.session.userId) {
    res.json({ loggedIn: true, username: req.session.username });
  } else if (req.user && req.user.id) {
    res.json({ loggedIn: true, username: req.user.username || req.user.email });
  } else {
    res.json({ loggedIn: false });
  }
});

// ─── GOOGLE OAUTH ROUTES ──────────────────────────────────────────────────────

app.get('/auth/google', (req, res, next) => {
  if (!GOOGLE_CLIENT_ID || !GOOGLE_CLIENT_SECRET) {
    return res.redirect('/login?error=google_not_configured');
  }
  passport.authenticate('google', { scope: ['profile', 'email'] })(req, res, next);
});

app.get('/auth/google/callback',
  passport.authenticate('google', { failureRedirect: '/login?error=google_failed' }),
  (req, res) => {
    // Set session userId so requireAuth works uniformly
    if (req.user) {
      req.session.userId = req.user.id;
      req.session.username = req.user.username || req.user.email;
    }
    res.redirect('/');
  }
);

// ─── ADMIN PAGE ROUTES ────────────────────────────────────────────────────────

app.get('/admin/login', (req, res) => {
  if (req.session && req.session.userId) return res.redirect('/admin');
  res.sendFile(path.join(__dirname, 'public', 'admin-login.html'));
});

app.get('/admin/signup', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'admin-signup.html'));
});

app.get('/admin', requireAuth, (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'admin.html'));
});

// ─── SERVER START ─────────────────────────────────────────────────────────────

const PORT = 5000;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`Server running on port ${PORT}`);
  if (process.send) {
    process.send('ready');
  }
});