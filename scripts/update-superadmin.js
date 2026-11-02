const { Pool } = require('pg');
const { randomBytes, scryptSync } = require('node:crypto');
const fs = require('fs');
const path = require('path');

const envPath = path.join(__dirname, '..', '.env');
for (const line of fs.readFileSync(envPath, 'utf8').split(/\r?\n/)) {
  const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
  if (match) process.env[match[1]] = match[2];
}

function hashPassword(password, salt = randomBytes(16).toString('hex')) {
  const hash = scryptSync(password, salt, 64).toString('hex');
  return { salt, hash };
}

async function run() {
  const pool = new Pool({ connectionString: process.env.SUPABASE_DB_URL });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // 1. Demote any current super admins to normal admin
    await client.query("UPDATE users SET is_super_admin = false WHERE role = 'admin'");

    // 2. Look for ran4code@gmail.com
    const email = 'ran4code@gmail.com';
    const targetPassword = 'Thakur@8851';
    const { salt, hash } = hashPassword(targetPassword);

    const { rows } = await client.query('SELECT id, email FROM users');
    const existing = rows.find(r => r.email.toLowerCase() === email.toLowerCase());

    if (existing) {
      await client.query(
        'UPDATE users SET role = $1, is_super_admin = $2, password_salt = $3, password_hash = $4 WHERE id = $5',
        ['admin', true, salt, hash, existing.id]
      );
      console.log(`Updated existing user (id: ${existing.id}) to Super Admin.`);
    } else {
      const res = await client.query(
        'INSERT INTO users (name, email, role, password_salt, password_hash, is_super_admin) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id',
        ['Super Admin', email, 'admin', salt, hash, true]
      );
      console.log(`Created new Super Admin user (id: ${res.rows[0].id}).`);
    }

    await client.query('COMMIT');

    const check = await client.query('SELECT id, name, email, role, is_super_admin FROM users ORDER BY id');
    console.log('--- UPDATED USERS LIST ---');
    console.table(check.rows);
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Error during update:', err);
  } finally {
    client.release();
    await pool.end();
  }
}

run();
