const fs = require("node:fs");
const path = require("node:path");
const { DatabaseSync } = require("node:sqlite");
const { Client } = require("pg");

const ROOT = path.resolve(__dirname, "..");
loadEnvFile();

const sourcePath = process.env.SQLITE_DATABASE_PATH || path.join(ROOT, "data", "travlish.sqlite");
const connectionString = process.env.SUPABASE_DB_URL;
const apply = process.argv.includes("--apply");
const tableNames = ["users", "sessions", "bookings", "document_verifications", "verification_logs"];

function loadEnvFile() {
  const envPath = path.join(ROOT, ".env");
  if (!fs.existsSync(envPath)) return;
  for (const line of fs.readFileSync(envPath, "utf8").split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (!match || Object.hasOwn(process.env, match[1])) continue;
    process.env[match[1]] = match[2].replace(/^(['"])(.*)\1$/, "$2");
  }
}

function readSourceDatabase() {
  if (!fs.existsSync(sourcePath)) {
    throw new Error(`SQLite source database not found: ${sourcePath}`);
  }
  const source = new DatabaseSync(sourcePath, { readOnly: true });
  try {
    source.exec("BEGIN");
    const data = Object.fromEntries(tableNames.map(name => [
      name,
      source.prepare(`SELECT * FROM ${name}`).all(),
    ]));
    source.exec("COMMIT");
    return data;
  } catch (error) {
    try { source.exec("ROLLBACK"); } catch {}
    throw error;
  } finally {
    source.close();
  }
}

async function insertRows(client, table, columns, rows) {
  for (let offset = 0; offset < rows.length; offset += 500) {
    const batch = rows.slice(offset, offset + 500);
    const values = [];
    const placeholders = batch.map((row, rowIndex) => {
      values.push(...columns.map(column => row[column]));
      const start = rowIndex * columns.length;
      return `(${columns.map((_, columnIndex) => `$${start + columnIndex + 1}`).join(", ")})`;
    });
    await client.query(
      `INSERT INTO ${table} (${columns.join(", ")}) VALUES ${placeholders.join(", ")}`,
      values
    );
  }
}

async function applyMigration(data) {
  if (!connectionString) {
    throw new Error("Set SUPABASE_DB_URL in .env to the Supabase Postgres session-pooler connection string first.");
  }

  const client = new Client({ connectionString, connectionTimeoutMillis: 10_000 });
  await client.connect();
  try {
    const schema = fs.readFileSync(path.join(ROOT, "data", "supabase_schema.sql"), "utf8");
    await client.query(schema);
    await client.query("BEGIN");
    for (const table of tableNames) {
      const { rows } = await client.query(`SELECT COUNT(*) AS count FROM public.${table}`);
      if (Number(rows[0].count) > 0) {
        throw new Error(`Supabase table "${table}" is not empty. No SQLite data was imported.`);
      }
    }

    await insertRows(client, "public.users",
      ["id", "name", "email", "role", "password_salt", "password_hash", "is_super_admin", "created_at"],
      data.users.map(user => ({
        ...user,
        email: user.email.trim().toLowerCase(),
        is_super_admin: Boolean(user.is_super_admin),
      })));
    await insertRows(client, "public.sessions",
      ["token", "user_id", "expires_at", "created_at"], data.sessions);
    await insertRows(client, "public.bookings",
      ["id", "user_id", "car", "customer", "phone", "email", "pickup_date", "handover",
        "pickup", "destination", "duration", "notes", "status", "created_at"], data.bookings);
    await insertRows(client, "public.document_verifications",
      ["id", "booking_id", "user_id", "document_type", "document_number", "document_name",
        "status", "verification_result", "verified_by", "submitted_at", "reviewed_at"],
      data.document_verifications);
    await insertRows(client, "public.verification_logs",
      ["id", "booking_id", "verification_id", "actor_role", "actor_id", "event", "details", "created_at"],
      data.verification_logs);

    for (const table of ["users", "bookings", "document_verifications", "verification_logs"]) {
      await client.query(`
        SELECT setval(
          pg_get_serial_sequence('public.${table}', 'id'),
          COALESCE((SELECT MAX(id) FROM public.${table}), 1),
          EXISTS (SELECT 1 FROM public.${table})
        )
      `);
    }
    await client.query("COMMIT");
    console.log("SQLite data imported successfully. Row counts:");
    for (const table of tableNames) console.log(`  ${table}: ${data[table].length}`);
    console.log("Keep the SQLite file as a backup until the Supabase-backed app has been verified.");
  } catch (error) {
    try { await client.query("ROLLBACK"); } catch {}
    throw error;
  } finally {
    await client.end();
  }
}

async function main() {
  const data = readSourceDatabase();
  if (!apply) {
    console.log("Dry run only. No Supabase connection was opened and no data was transferred.");
    for (const table of tableNames) console.log(`  ${table}: ${data[table].length}`);
    console.log("Review the counts, set SUPABASE_DB_URL in .env, then run: npm run migrate:supabase -- --apply");
    return;
  }
  await applyMigration(data);
}

main().catch(error => {
  console.error("Supabase migration failed:", error.message);
  process.exitCode = 1;
});
