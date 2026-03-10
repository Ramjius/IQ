const express = require('express');
const bodyParser = require('body-parser');
const cors = require('cors');
const PDFDocument = require('pdfkit');
const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');
require('dotenv').config();

const app = express();
app.use(bodyParser.json());
app.use(cors());
app.use(express.static(path.join(__dirname, 'public'))); // serve static files

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

pool.connect((err, client, release) => {
  if (err) {
    console.error('Error connecting to PostgreSQL:', err);
    return;
  }
  release();
  console.log('Connected to PostgreSQL database');
});

// Route for serving the dashboard
app.get('/', (req, res) => {
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
          text-align: center;
        }
        .nav-menu a {
          color: white;
          text-decoration: none;
          margin: 0 15px;
          font-size: 16px;
          padding: 5px 10px;
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
        </div>
      </div>
      <script>
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
                <td><button onclick="reprintInvoice('\${i.invoice_number}')">Reprint</button></td>
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
                <td><button onclick="reprintQuotation('\${q.quote_number}')">Reprint</button></td>
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
app.get('/invoices', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'invoices.html'));
});

// Serve quotations page
app.get('/quotations', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'quotations.html'));
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
app.post('/api/save-quotation', (req, res) => {
  const { quoteNumber, customerName, address, salesperson, paymentTerms, dueDate, items, totalAmount, paymentDetails } = req.body;
  
  // First, upsert client
  const upsertClient = `INSERT INTO clients (name, address) VALUES (?, ?) ON CONFLICT (name) DO UPDATE SET address = EXCLUDED.address`;
  connection.query(upsertClient, [customerName, address], (clientErr) => {
    if (clientErr) console.error('Error upserting client:', clientErr);
    
    const query = `
      INSERT INTO quotations (date, quote_number, customer_name, address, salesperson, payment_terms, due_date, items, total_amount, payment_details)
      VALUES (NOW(), ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `;
    connection.query(query, [quoteNumber, customerName, address, salesperson, paymentTerms, dueDate, JSON.stringify(items), totalAmount, paymentDetails], (err, result) => {
      if (err) {
        console.error('Database Error:', err);
        return res.redirect('/error');
      }
      res.redirect('/success');
    });
  });
});

// Save Invoice
app.post('/api/save-invoice', (req, res) => {
  const { invoiceNumber, customerName, address, items, totalAmount, paymentDetails, status } = req.body;
  
  // First, upsert client
  const upsertClient = `INSERT INTO clients (name, address) VALUES (?, ?) ON CONFLICT (name) DO UPDATE SET address = EXCLUDED.address`;
  connection.query(upsertClient, [customerName, address], (clientErr) => {
    if (clientErr) console.error('Error upserting client:', clientErr);

    const query = `
      INSERT INTO invoices (date, invoice_number, customer_name, address, items, total_amount, payment_details, status)
      VALUES (NOW(), ?, ?, ?, ?, ?, ?, ?)
    `;
    connection.query(query, [invoiceNumber, customerName, address, JSON.stringify(items), totalAmount, paymentDetails, status || 'pending'], (err, result) => {
      if (err) {
        console.error('Database Error:', err);
        return res.status(500).send('Failed to save invoice');
      }
      res.send('Invoice saved successfully!');
    });
  });
});

// Get Clients
app.get('/api/clients', (req, res) => {
  connection.query('SELECT name, address FROM clients ORDER BY name ASC', (err, results) => {
    if (err) return res.status(500).send('Failed to fetch clients');
    res.json(results);
  });
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

// Export Quotation as PDF - FIXED VERSION
app.post('/api/export-quotation-pdf', (req, res) => {
  const { quoteNumber, customerName, address, salesperson, paymentTerms, dueDate, items, totalAmount, paymentDetails } = req.body;
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
  doc.text(`Date: ${new Date().toLocaleDateString()}`, 0, 115, { align: 'right', width: 540 });

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
  const { invoiceNumber, customerName, address, items, totalAmount, status, paymentDetails } = req.body;
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
  doc.text(`Date: ${new Date().toLocaleDateString()}`, 0, 115, { align: 'right', width: 540 });
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

  // Payment Details and Closing Text
  y += 60;
  doc.fontSize(12).text('Payment Details:', 50, y);
  y += 20;
  doc.text(paymentDetails || 'CHEQUE NAME: RAMTECHNOLOGIES', 50, y);
  y += 20;
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

  // Payment Details and Closing Text with Signature Image
  y += 80; // Additional space before payment details
  doc.fontSize(12).text('Payment Details:', 50, y);
  y += 20;
  doc.text(invoice.payment_details || 'CHEQUE NAME: RAMTECHNOLOGIES', 50, y);
  y += 20;
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

// Get the next available invoice number
app.get('/api/next-invoice-number', (req, res) => {
  const currentYear = new Date().getFullYear().toString(); // e.g., "2025"
  const query = `
    SELECT invoice_number 
    FROM invoices 
    WHERE invoice_number LIKE ? 
    ORDER BY invoice_number DESC 
    LIMIT 1
  `;
  const searchPattern = `${currentYear}%`; // e.g., "2025%"

  connection.query(query, [searchPattern], (err, results) => {
    if (err) {
      console.error('Error fetching invoice numbers:', err);
      return res.status(500).json({ error: 'Failed to fetch invoice number' });
    }

    let nextNumber = '01'; // Default to "01" if no invoices exist for the year
    if (results.length > 0) {
      const lastInvoiceNumber = results[0].invoice_number; // e.g., "202504"
      const lastSequentialNumber = parseInt(lastInvoiceNumber.slice(-2)); // e.g., 04
      nextNumber = (lastSequentialNumber + 1).toString().padStart(2, '0'); // e.g., "05"
    }

    const nextInvoiceNumber = `${currentYear}${nextNumber}`; // e.g., "202505"
    res.json({ invoiceNumber: nextInvoiceNumber });
  });
});

// Get the next available quotation number
app.get('/api/next-quotation-number', (req, res) => {
  const currentYear = new Date().getFullYear().toString(); // e.g., "2025"
  const query = `
    SELECT quote_number 
    FROM quotations 
    WHERE quote_number LIKE ? 
    ORDER BY quote_number DESC 
    LIMIT 1
  `;
  const searchPattern = `${currentYear}%`; // e.g., "2025%"

  connection.query(query, [searchPattern], (err, results) => {
    if (err) {
      console.error('Error fetching quotation numbers:', err);
      return res.status(500).json({ error: 'Failed to fetch quotation number' });
    }

    let nextNumber = '01'; // Default to "01" if no quotations exist for the year
    if (results.length > 0) {
      const lastQuoteNumber = results[0].quote_number; // e.g., "202504"
      const lastSequentialNumber = parseInt(lastQuoteNumber.slice(-2)); // e.g., 04
      nextNumber = (lastSequentialNumber + 1).toString().padStart(2, '0'); // e.g., "05"
    }

    const nextQuoteNumber = `${currentYear}${nextNumber}`; // e.g., "202505"
    res.json({ quoteNumber: nextQuoteNumber });
  });
});

const PORT = 5000;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`Server running on port ${PORT}`);
  if (process.send) {
    process.send('ready');
  }
});