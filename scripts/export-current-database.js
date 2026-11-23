require('dotenv').config();

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

function fail(message) {
  console.error(message);
  process.exit(1);
}

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  fail('DATABASE_URL is not configured in the environment or .env file.');
}

let url;
try {
  url = new URL(databaseUrl);
} catch {
  fail('DATABASE_URL is not a valid PostgreSQL connection URL.');
}

if (!['postgres:', 'postgresql:'].includes(url.protocol)) {
  fail('DATABASE_URL must use the postgres:// or postgresql:// scheme.');
}

const databaseName = decodeURIComponent(url.pathname.replace(/^\/+/, ''));
if (!url.hostname || !databaseName) {
  fail('DATABASE_URL must include a database host and database name.');
}

const outputDirectory = path.join(__dirname, '..', 'backups');
fs.mkdirSync(outputDirectory, { recursive: true, mode: 0o700 });
process.umask(0o077);
const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
const backupFile = path.join(outputDirectory, `invoicing-${timestamp}.backup`);

const pgEnv = { ...process.env };
delete pgEnv.DATABASE_URL;
pgEnv.PGHOST = url.hostname;
pgEnv.PGPORT = url.port || '5432';
pgEnv.PGUSER = decodeURIComponent(url.username);
pgEnv.PGPASSWORD = decodeURIComponent(url.password);
pgEnv.PGDATABASE = databaseName;
pgEnv.PGCONNECT_TIMEOUT = pgEnv.PGCONNECT_TIMEOUT || '15';

const libpqOptions = {
  application_name: 'invoicing-database-backup',
  channel_binding: 'PGCHANNELBINDING',
  connect_timeout: 'PGCONNECT_TIMEOUT',
  options: 'PGOPTIONS',
  sslcert: 'PGSSLCERT',
  sslkey: 'PGSSLKEY',
  sslmode: 'PGSSLMODE',
  sslrootcert: 'PGSSLROOTCERT',
  target_session_attrs: 'PGTARGETSESSIONATTRS',
};
for (const [option, envName] of Object.entries(libpqOptions)) {
  const value = url.searchParams.get(option);
  if (value) {
    pgEnv[envName === 'application_name' ? 'PGAPPNAME' : envName] = value;
  }
}

const result = spawnSync('pg_dump', [
  '--format=custom',
  '--no-owner',
  '--no-acl',
  '--no-password',
  '--file',
  backupFile,
], {
  env: pgEnv,
  stdio: 'inherit',
});

if (result.error || result.status !== 0) {
  fs.rmSync(backupFile, { force: true });
  fail(result.error
    ? 'Could not run pg_dump. Install PostgreSQL command-line tools and ensure pg_dump is on PATH.'
    : `pg_dump failed with exit code ${result.status}. No backup was kept.`);
}

console.log(`Database backup created: ${backupFile}`);
console.log('This file contains financial data. Keep it private and copy it to a separate backup location.');
