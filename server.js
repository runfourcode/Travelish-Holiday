const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const {
  randomBytes,
  scryptSync,
  timingSafeEqual,
} = require("node:crypto");
const { Pool } = require("pg");

const ROOT = __dirname;
loadEnvFile();
const PORT = Number(process.env.PORT || 3000);
const SUPABASE_DB_URL = process.env.SUPABASE_DB_URL;
const SESSION_DAYS = 7;
const MAX_BODY_BYTES = 32 * 1024;
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

if (!SUPABASE_DB_URL) {
  throw new Error("Supabase Postgres is not configured. Set SUPABASE_DB_URL in .env before starting the server.");
}

const pool = new Pool({
  connectionString: SUPABASE_DB_URL,
  max: Number(process.env.DB_POOL_MAX || 10),
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 30_000,
});
pool.on("error", error => console.error("Supabase Postgres pool error:", error.message));

function prepareSql(sql) {
  const toPostgresSql = () => {
    let index = 0;
    return sql
      .replace(/\bAS\s+([A-Za-z_][A-Za-z0-9_]*)/gi, (_, alias) => `AS "${alias}"`)
      .replace(/\?/g, () => `$${++index}`);
  };
  return {
    async get(...values) {
      const result = await pool.query(toPostgresSql(), values);
      return result.rows[0];
    },
    async all(...values) {
      const result = await pool.query(toPostgresSql(), values);
      return result.rows;
    },
    async run(...values) {
      const result = await pool.query(toPostgresSql(), values);
      return { lastInsertRowid: result.rows[0]?.id, changes: result.rowCount };
    },
  };
}
const db = { prepare: prepareSql };

const statements = {
  createUser: db.prepare(
    "INSERT INTO users (name, email, role, password_salt, password_hash, is_super_admin) VALUES (?, ?, ?, ?, ?, ?) RETURNING id"
  ),
  findUser: db.prepare("SELECT * FROM users WHERE lower(email) = ?"),
  countAdmins: db.prepare("SELECT COUNT(*) AS count FROM users WHERE role = 'admin'"),
  createSession: db.prepare("INSERT INTO sessions (token, user_id, expires_at) VALUES (?, ?, ?)"),
  findSession: db.prepare(`
    SELECT users.id, users.name, users.email, users.role, users.is_super_admin AS isSuperAdmin
    FROM sessions JOIN users ON users.id = sessions.user_id
    WHERE sessions.token = ? AND sessions.expires_at > ?
  `),
  deleteSession: db.prepare("DELETE FROM sessions WHERE token = ?"),
  createBooking: db.prepare(`
    INSERT INTO bookings
      (user_id, car, customer, phone, email, pickup_date, handover, pickup, destination, duration, notes)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id
  `),
  listBookings: db.prepare(`
    SELECT b.id, b.user_id AS userId, b.car, b.customer, b.phone, b.email,
      b.pickup_date AS pickupDate, b.handover, b.pickup, b.destination, b.duration,
      b.notes, b.status, b.created_at AS createdAt,
      u.name AS accountName, u.email AS accountEmail
    FROM bookings b LEFT JOIN users u ON u.id = b.user_id
    ORDER BY b.created_at DESC, b.id DESC LIMIT 500
  `),
  listClients: db.prepare(`
    SELECT u.id, u.name, u.email, u.created_at AS createdAt,
      COUNT(b.id) AS bookingCount
    FROM users u LEFT JOIN bookings b ON b.user_id = u.id
    WHERE u.role = 'client'
    GROUP BY u.id ORDER BY u.created_at DESC, u.id DESC LIMIT 500
  `),
  listStaff: db.prepare(`
    SELECT id, name, email, is_super_admin AS isSuperAdmin, created_at AS createdAt
    FROM users WHERE role = 'admin' ORDER BY is_super_admin DESC, created_at, id
  `),
  getBooking: db.prepare("SELECT id, user_id AS userId, status FROM bookings WHERE id = ?"),
  setBookingStatus: db.prepare("UPDATE bookings SET status = ? WHERE id = ?"),
  insertVerification: db.prepare(`
    INSERT INTO document_verifications
      (booking_id, user_id, document_type, document_number, document_name, status, verification_result, verified_by, reviewed_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id
  `),
  listVerificationsForBooking: db.prepare(`
    SELECT id, booking_id AS bookingId, user_id AS userId, document_type AS documentType,
      document_number AS documentNumber, document_name AS documentName, status, verification_result AS verificationResult,
      verified_by AS verifiedBy, submitted_at AS submittedAt, reviewed_at AS reviewedAt
    FROM document_verifications WHERE booking_id = ? ORDER BY submitted_at DESC, id DESC
  `),
  createVerificationLog: db.prepare(`
    INSERT INTO verification_logs (booking_id, verification_id, actor_role, actor_id, event, details)
    VALUES (?, ?, ?, ?, ?, ?)
  `),
  listBookingLogs: db.prepare(`
    SELECT booking_id AS bookingId, verification_id AS verificationId, actor_role AS actorRole, actor_id AS actorId,
      event, details, created_at AS createdAt
    FROM verification_logs WHERE booking_id = ? ORDER BY created_at DESC, id DESC LIMIT 200
  `),
};

const sessionsCookie = "travlish_session";
const loginAttempts = new Map();

const server = http.createServer(async (request, response) => {
  setSecurityHeaders(response);

  try {
    const url = new URL(request.url, `http://${request.headers.host || "localhost"}`);
    const pathname = decodeURIComponent(url.pathname);

    if (request.method === "GET" && pathname === "/api/config") {
      const adminExists = Number((await statements.countAdmins.get()).count) > 0;
      return sendJson(response, 200, {
        adminRegistrationOpen: !adminExists && Boolean(process.env.ADMIN_SETUP_TOKEN),
        googleAuthEnabled: false,
      });
    }

    function getContentType(filePath) {
      const types = {
        ".html": "text/html; charset=utf-8",
        ".css": "text/css; charset=utf-8",
        ".js": "text/javascript; charset=utf-8",
        ".jpeg": "image/jpeg",
        ".jpg": "image/jpeg",
        ".png": "image/png",
        ".webp": "image/webp",
        ".svg": "image/svg+xml",
      };
      return types[path.extname(filePath).toLowerCase()] || "application/octet-stream";
    }

    if (request.method === "POST" && pathname === "/api/bookings") {
      return await createBooking(request, response);
    }

    if (request.method === "POST" && pathname === "/api/admin/bookings/status") {
      const user = await requireAdmin(request, response);
      if (!user) return;
      return await updateBookingStatus(request, response);
    }

    if (request.method === "GET" && pathname === "/api/admin/dashboard") {
      const user = await requireAdmin(request, response);
      if (!user) return;
      return sendJson(response, 200, await getDashboardData(user));
    }

    if (request.method === "POST" && pathname === "/api/admin/users") {
      const user = await requireAdmin(request, response);
      if (!user) return;
      return await createStaffAccount(request, response);
    }

    if (request.method === "GET" && pathname === "/api/client/dashboard") {
      const user = await requireClient(request, response);
      if (!user) return;
      return sendJson(response, 200, await getClientDashboardData(user));
    }

    if (request.method === "GET" && pathname === "/Client/dashboard.html") {
      const user = await getSessionUser(request);
      if (!user || user.role !== "client") {
        response.writeHead(302, { Location: "/Client/login.html?error=Please%20sign%20in%20to%20access%20your%20dashboard." });
        return response.end();
      }
    }

    if (request.method === "GET" && pathname === "/api/admin/document-verifications") {
      if (!await requireAdmin(request, response)) return;
      return sendJson(response, 200, await getAdminVerificationData());
    }

    if (request.method === "POST" && pathname === "/api/client/document-verification") {
      const user = await requireClient(request, response);
      if (!user) return;
      return await submitClientVerification(request, response, user);
    }

    if (request.method === "POST" && pathname.startsWith("/api/admin/document-verifications/")) {
      if (!await requireAdmin(request, response)) return;
      return await updateDocumentSubmission(request, response);
    }

    if (request.method === "GET" && pathname === "/api/me") {
      const user = await getSessionUser(request);
      return sendJson(response, 200, {
        user: user ? {
          name: user.name,
          email: user.email,
          role: user.role,
          isSuperAdmin: Boolean(user.isSuperAdmin),
        } : null,
      });
    }

    if (request.method === "POST" && pathname === "/auth/logout") {
      return logout(request, response);
    }

    if (request.method === "GET" && pathname.endsWith("/auth/google")) {
      const loginPath = pathname.startsWith("/admin/") ? "/Admin/login.html" : "/Client/login.html";
      return sendHtml(response, 501, pageMessage(
        "Google sign-in is not configured",
        "Set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET in your environment before enabling Google sign-in.",
        loginPath
      ));
    }

    if (request.method === "GET" && pathname.endsWith("/auth/forgot-password")) {
      const loginPath = pathname.startsWith("/admin/") ? "/Admin/login.html" : "/Client/login.html";
      return sendHtml(response, 501, pageMessage(
        "Password reset is unavailable",
        "No email delivery service is configured for this project. Contact the site administrator to reset your password.",
        loginPath
      ));
    }

    if (request.method === "POST" && pathname === "/admin/auth/register") {
      return await registerAdmin(request, response);
    }

    if (request.method === "POST" && pathname === "/client/auth/register") {
      return await registerClient(request, response);
    }

    if (request.method === "POST" && (pathname === "/admin/auth/login" || pathname === "/client/auth/login")) {
      return await login(request, response, pathname.startsWith("/admin/") ? "admin" : "client");
    }

    if (request.method === "POST" && pathname === "/auth/password-reset") {
      return sendHtml(response, 501, pageMessage(
        "Password reset is unavailable",
        "No email delivery service is configured for this project. Contact the site administrator to reset your password.",
        "/Client/login.html"
      ));
    }

    if (request.method !== "GET" && request.method !== "HEAD") {
      return sendJson(response, 404, { error: "Route not found." });
    }

    const filePath = resolvePublicFile(pathname);
    if (!filePath) return sendJson(response, 404, { error: "Page not found." });

    if (filePath === path.join(ROOT, "Admin", "dashboard.html")) {
      const user = await getSessionUser(request);
      if (!user || user.role !== "admin") {
        response.writeHead(302, { Location: "/Admin/login.html?error=Please%20sign%20in%20as%20an%20administrator." });
        return response.end();
      }
      if (user.isSuperAdmin) {
        response.writeHead(302, { Location: "/Super-Admin/dashboard.html" });
        return response.end();
      }
    }
    if (filePath === path.join(ROOT, "Super-Admin", "dashboard.html")) {
      const user = await getSessionUser(request);
      if (!user || user.role !== "admin" || !user.isSuperAdmin) {
        response.writeHead(302, { Location: "/Admin/login.html?error=Please%20sign%20in%20as%20a%20super-administrator." });
        return response.end();
      }
    }
    if (filePath === path.join(ROOT, "Client", "dashboard.html")) {
      const user = await getSessionUser(request);
      if (!user || user.role !== "client") {
        response.writeHead(302, { Location: "/Client/login.html?error=Please%20sign%20in%20as%20a%20client." });
        return response.end();
      }
    }

    const contentType = getContentType(filePath);
    response.writeHead(200, { "Content-Type": contentType });
    if (request.method === "HEAD") return response.end();
    return fs.createReadStream(filePath).pipe(response);
  } catch (error) {
    console.error("Request failed:", error);
    if (!response.headersSent) sendJson(response, error.statusCode || 500, { error: error.statusCode ? error.message : "An unexpected server error occurred." });
    else response.destroy(error);
  }
});

async function startServer() {
  await pool.query("SELECT 1");
  const schema = await pool.query(`
    SELECT to_regclass('public.users') AS users,
      to_regclass('public.sessions') AS sessions,
      to_regclass('public.bookings') AS bookings,
      to_regclass('public.document_verifications') AS verifications,
      to_regclass('public.verification_logs') AS logs
  `);
  if (Object.values(schema.rows[0]).some(table => table === null)) {
    throw new Error("Travlish tables are missing in Supabase. After setting SUPABASE_DB_URL, run npm run migrate:supabase -- --apply.");
  }
  await pool.query("SELECT is_super_admin FROM public.users LIMIT 0");
  await seedAdminFromEnvironment();
  server.listen(PORT, () => {
    console.log(`Travlish is running at http://localhost:${PORT}`);
    console.log("Database: Supabase Postgres");
  });
}

function loadEnvFile() {
  const envPath = path.join(ROOT, ".env");
  if (!fs.existsSync(envPath)) return;

  for (const line of fs.readFileSync(envPath, "utf8").split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (!match || Object.hasOwn(process.env, match[1])) continue;
    const value = match[2].replace(/^(['"])(.*)\1$/, "$2");
    process.env[match[1]] = value;
  }
}

async function seedAdminFromEnvironment() {
  const email = process.env.ADMIN_EMAIL?.trim().toLowerCase();
  const password = process.env.ADMIN_PASSWORD;
  if (!email && !password) return;
  if (!email || !password || !EMAIL_PATTERN.test(email) || password.length < 12) {
    throw new Error("Set both ADMIN_EMAIL and ADMIN_PASSWORD; the password must be at least 12 characters.");
  }

  const existing = await db.prepare("SELECT id, role FROM users WHERE lower(email) = ?").get(email);
  if (existing) {
    if (existing.role === "admin") {
      await db.prepare("UPDATE users SET is_super_admin = TRUE WHERE id = ?").run(existing.id);
    }
    return;
  }
  const { salt, hash } = hashPassword(password);
  await statementsCreateUser("Admin", email, "admin", salt, hash, true);
  console.log(`Created initial super-admin account for ${email}.`);
}

async function statementsCreateUser(name, email, role, salt, hash, isSuperAdmin = false) {
  await statements.createUser.run(name, email, role, salt, hash, isSuperAdmin);
}

function hashPassword(password, salt = randomBytes(16).toString("hex")) {
  const hash = scryptSync(password, salt, 64).toString("hex");
  return { salt, hash };
}

function passwordMatches(password, salt, expectedHash) {
  const actual = Buffer.from(hashPassword(password, salt).hash, "hex");
  const expected = Buffer.from(expectedHash, "hex");
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

async function createSession(response, userId, remember = false) {
  const token = randomBytes(32).toString("hex");
  const duration = remember ? SESSION_DAYS * 24 * 60 * 60 : 12 * 60 * 60;
  await statements.createSession.run(token, userId, Date.now() + duration * 1000);
  const secure = process.env.COOKIE_SECURE === "true" ? "; Secure" : "";
  const maxAge = remember ? `; Max-Age=${duration}` : "";
  response.setHeader("Set-Cookie", `${sessionsCookie}=${token}; HttpOnly; SameSite=Lax; Path=/${maxAge}${secure}`);
}

async function getSessionUser(request) {
  const token = parseCookies(request.headers.cookie)[sessionsCookie];
  return token ? await statements.findSession.get(token, Date.now()) || null : null;
}

async function requireAdmin(request, response) {
  const user = await getSessionUser(request);
  if (!user || user.role !== "admin") {
    sendJson(response, 401, { error: "Administrator sign-in is required." });
    return null;
  }
  return user;
}

async function requireClient(request, response) {
  const user = await getSessionUser(request);
  if (!user || user.role !== "client") {
    sendJson(response, 401, { error: "Client sign-in is required." });
    return null;
  }
  return user;
}

function parseCookies(header = "") {
  return Object.fromEntries(header.split(";").map(part => {
    const index = part.indexOf("=");
    return index < 0 ? ["", ""] : [part.slice(0, index).trim(), decodeURIComponent(part.slice(index + 1).trim())];
  }).filter(([key]) => key));
}

async function readBody(request) {
  const chunks = [];
  let bytes = 0;
  for await (const chunk of request) {
    bytes += chunk.length;
    if (bytes > MAX_BODY_BYTES) throw Object.assign(new Error("Request body is too large."), { statusCode: 413 });
    chunks.push(chunk);
  }

  const raw = Buffer.concat(chunks).toString("utf8");
  const contentType = request.headers["content-type"] || "";
  if (contentType.includes("application/json")) {
    try {
      const body = JSON.parse(raw);
      if (!body || typeof body !== "object" || Array.isArray(body)) throw new Error("Expected an object.");
      return body;
    } catch {
      throw Object.assign(new Error("Invalid JSON request body."), { statusCode: 400 });
    }
  }
  return Object.fromEntries(new URLSearchParams(raw));
}

async function readForm(request) {
  try {
    return await readBody(request);
  } catch (error) {
    throw Object.assign(error, { statusCode: error.statusCode || 400 });
  }
}

async function login(request, response, requiredRole) {
  const body = await readForm(request);
  const email = String(body.email || "").trim().toLowerCase();
  const password = String(body.password || "");
  const key = `${request.socket.remoteAddress}:${email}`;
  const attempt = loginAttempts.get(key) || { count: 0, until: 0 };

  if (attempt.until > Date.now()) {
    return authError(response, requiredRole, "Too many attempts. Try again in 15 minutes.", false, body.next);
  }
  const user = await statements.findUser.get(email);
  if (!EMAIL_PATTERN.test(email) || !user || user.role !== requiredRole || !passwordMatches(password, user.password_salt, user.password_hash)) {
    attempt.count += 1;
    attempt.until = attempt.count >= 8 ? Date.now() + 15 * 60 * 1000 : 0;
    loginAttempts.set(key, attempt);
    return authError(response, requiredRole, "Email or password is incorrect.", false, body.next);
  }

  loginAttempts.delete(key);
  await createSession(response, user.id, body.remember === "on" || body.remember === "1");
  const destination = requiredRole === "admin"
    ? (user.is_super_admin ? "/Super-Admin/dashboard.html" : "/Admin/dashboard.html")
    : clientReturnPath(body.next);
  response.writeHead(303, { Location: destination });
  response.end();
}

async function registerClient(request, response) {
  const body = await readForm(request);
  const result = validateAccount(body, true);
  if (result.error) return authError(response, "client", result.error, true, body.next);

  const { salt, hash } = hashPassword(result.password);
  try {
    const created = await statements.createUser.run(result.name, result.email, "client", salt, hash, false);
    await createSession(response, Number(created.lastInsertRowid), false);
    response.writeHead(303, { Location: clientReturnPath(body.next) });
    response.end();
  } catch (error) {
    if (error.code === "23505" || String(error.message).includes("UNIQUE")) {
      return authError(response, "client", "An account with this email already exists.", true, body.next);
    }
    throw error;
  }
}

async function registerAdmin(request, response) {
  const body = await readForm(request);
  if (!process.env.ADMIN_SETUP_TOKEN || Number((await statements.countAdmins.get()).count) > 0) {
    return authError(response, "admin", "Administrator registration is closed.");
  }
  if (!safeSecretEqual(String(body.setupToken || ""), process.env.ADMIN_SETUP_TOKEN)) {
    return authError(response, "admin", "The administrator setup token is incorrect.", true);
  }

  const result = validateAccount(body, true);
  if (result.error) return authError(response, "admin", result.error, true);
  const { salt, hash } = hashPassword(result.password);
  try {
    const created = await statements.createUser.run(result.name, result.email, "admin", salt, hash, true);
    await createSession(response, Number(created.lastInsertRowid), false);
    response.writeHead(303, { Location: "/Admin/dashboard.html" });
    response.end();
  } catch (error) {
    if (error.code === "23505" || String(error.message).includes("UNIQUE")) {
      return authError(response, "admin", "An account with this email already exists.", true);
    }
    throw error;
  }
}

async function createStaffAccount(request, response) {
  const body = await readBody(request);
  const result = validateAccount(body, true);
  if (result.error) return sendJson(response, 400, { error: result.error });
  if (result.password.length < 12) {
    return sendJson(response, 400, { error: "Team passwords must be at least 12 characters." });
  }
  const isSuperAdmin = body.accountType === "super_admin";
  if (!isSuperAdmin && body.accountType !== "admin") {
    return sendJson(response, 400, { error: "Choose an administrator account type." });
  }

  const { salt, hash } = hashPassword(result.password);
  try {
    const created = await statements.createUser.run(result.name, result.email, "admin", salt, hash, isSuperAdmin);
    return sendJson(response, 201, {
      id: Number(created.lastInsertRowid),
      name: result.name,
      email: result.email,
      role: isSuperAdmin ? "super_admin" : "admin",
    });
  } catch (error) {
    if (error.code === "23505" || String(error.message).includes("UNIQUE")) {
      return sendJson(response, 409, { error: "An account with this email already exists." });
    }
    throw error;
  }
}

function validateAccount(body, needsName) {
  const name = String(body.name || "").trim();
  const email = String(body.email || "").trim().toLowerCase();
  const password = String(body.password || "");
  if (needsName && (name.length < 2 || name.length > 120)) return { error: "Enter a name between 2 and 120 characters." };
  if (!EMAIL_PATTERN.test(email) || email.length > 254) return { error: "Enter a valid email address." };
  if (password.length < 8 || password.length > 256) return { error: "Password must be between 8 and 256 characters." };
  if (String(body.confirmPassword || "") !== password) return { error: "Passwords do not match." };
  return { name, email, password };
}

function safeSecretEqual(input, expected) {
  const actual = Buffer.from(input);
  const target = Buffer.from(expected);
  return actual.length === target.length && timingSafeEqual(actual, target);
}

async function createBooking(request, response) {
  const body = await readBody(request);
  const user = await getSessionUser(request);
  const fields = {
    car: body.car,
    customer: body.customer,
    phone: body.phone,
    email: body.email,
    pickupDate: body.pickupDate,
    handover: body.handover,
    pickup: body.pickup,
    destination: body.destination,
    duration: body.duration,
    notes: body.notes,
  };
  const limits = { car: 120, customer: 120, phone: 40, email: 254, handover: 160, pickup: 300, destination: 300, duration: 200, notes: 2000 };
  for (const [field, limit] of Object.entries(limits)) {
    if (String(fields[field] || "").length > limit) return sendJson(response, 400, { error: `${field} is too long.` });
  }
  for (const field of ["car", "customer", "phone", "pickupDate", "handover", "pickup", "destination"]) {
    if (!String(fields[field] || "").trim()) return sendJson(response, 400, { error: `Please provide ${field}.` });
  }
  const parsedPickupDate = new Date(`${fields.pickupDate}T00:00:00Z`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(fields.pickupDate))
    || Number.isNaN(parsedPickupDate.getTime())
    || parsedPickupDate.toISOString().slice(0, 10) !== fields.pickupDate
    || fields.pickupDate < new Date().toISOString().slice(0, 10)) {
    return sendJson(response, 400, { error: "Choose a valid pickup date." });
  }
  if (!["At my doorstep — deliver the car to my location", "I'll collect and return the car myself"].includes(fields.handover)) {
    return sendJson(response, 400, { error: "Choose a valid handover option." });
  }
  if (fields.email && !EMAIL_PATTERN.test(String(fields.email))) return sendJson(response, 400, { error: "Enter a valid email address." });
  if (String(fields.phone).replace(/\D/g, "").length < 7) return sendJson(response, 400, { error: "Enter a valid phone number." });

  let bookingUserId = user ? user.id : null;
  if (!bookingUserId && fields.email) {
    const existing = await statements.findUser.get(String(fields.email).trim().toLowerCase());
    if (existing) {
      bookingUserId = existing.id;
    }
  }

  const inserted = await statements.createBooking.run(
    bookingUserId,
    String(fields.car).trim(),
    String(fields.customer).trim(),
    String(fields.phone).trim(),
    fields.email ? String(fields.email).trim().toLowerCase() : null,
    String(fields.pickupDate),
    String(fields.handover).trim(),
    String(fields.pickup).trim(),
    String(fields.destination).trim(),
    String(fields.duration || "").trim(),
    String(fields.notes || "").trim()
  );
  const bookingId = Number(inserted.lastInsertRowid);
  const actorRole = user ? (user.role === "admin" ? "admin" : "client") : "client";
  const actorEmail = user?.email || fields.email || fields.customer;
  await statements.createVerificationLog.run(
    bookingId,
    null,
    actorRole,
    bookingUserId,
    "booking_submitted",
    `Booking request created for ${String(fields.car).trim()} by ${actorEmail}`
  );
  return sendJson(response, 201, { id: bookingId, status: "pending" });
}

async function updateBookingStatus(request, response) {
  const admin = await requireAdmin(request, response);
  if (!admin) return;
  const body = await readBody(request);
  const id = Number(body.id);
  const status = String(body.status || "");
  if (!Number.isSafeInteger(id) || id < 1) return sendJson(response, 400, { error: "Invalid booking id." });
  if (!["pending", "confirmed", "completed", "cancelled"].includes(status)) {
    return sendJson(response, 400, { error: "Choose a valid booking status." });
  }
  const booking = await statements.getBooking.get(id);
  if (!booking) return sendJson(response, 404, { error: "Booking not found." });
  await statements.setBookingStatus.run(status, id);
  await statements.createVerificationLog.run(id, null, "admin", admin.id, "booking_status_updated", `Booking status changed to ${status}`);
  return sendJson(response, 200, { id, status });
}

async function getDashboardData(user) {
  const [bookings, totalResult, clientsResult, statusCounts, pendingDocumentResult, clients, staff] = await Promise.all([
    statements.listBookings.all(),
    db.prepare("SELECT COUNT(*) AS count FROM bookings").get(),
    db.prepare("SELECT COUNT(*) AS count FROM users WHERE role = 'client'").get(),
    db.prepare("SELECT status, COUNT(*) AS count FROM bookings GROUP BY status").all(),
    db.prepare("SELECT COUNT(*) AS count FROM document_verifications WHERE status IN ('submitted', 'under_review')").get(),
    statements.listClients.all(),
    statements.listStaff.all(),
  ]);
  const totalBookings = Number(totalResult.count);
  const customers = Number(clientsResult.count);
  const pendingDocumentCount = Number(pendingDocumentResult.count);
  return {
    bookings,
    clients,
    staff,
    user: {
      name: user.name,
      email: user.email,
      isSuperAdmin: Boolean(user.isSuperAdmin),
    },
    stats: {
      bookings: totalBookings,
      customers,
      enquiries: Number(statusCounts.find(item => item.status === "pending")?.count || 0),
      confirmed: Number(statusCounts.find(item => item.status === "confirmed")?.count || 0),
      completed: Number(statusCounts.find(item => item.status === "completed")?.count || 0),
      documentChecks: pendingDocumentCount,
      statusCounts: Object.fromEntries(statusCounts.map(item => [item.status, Number(item.count)])),
    },
  };
}

async function getClientDashboardData(user) {
  const bookings = await db.prepare(`
    SELECT id, car, customer, phone, email, pickup_date AS pickupDate,
      handover, pickup, destination, duration, notes, status, created_at AS createdAt
    FROM bookings WHERE user_id = ? OR lower(email) = lower(?) ORDER BY created_at DESC, id DESC LIMIT 100
  `).all(user.id, user.email);
  const documents = await db.prepare(`
    SELECT id, booking_id AS bookingId, document_type AS documentType, document_number AS documentNumber,
      document_name AS documentName, status, verification_result AS verificationResult, submitted_at AS submittedAt
    FROM document_verifications WHERE user_id = ? ORDER BY submitted_at DESC, id DESC
  `).all(user.id);
  return { bookings, documents, user: { name: user.name, email: user.email, role: user.role } };
}

async function getAdminVerificationData() {
  const rows = await db.prepare(`
    SELECT v.id, v.booking_id AS bookingId, b.car, u.name AS customerName, u.email AS customerEmail,
      v.document_type AS documentType, v.document_number AS documentNumber, v.document_name AS documentName,
      v.status, v.verification_result AS verificationResult, v.submitted_at AS submittedAt
    FROM document_verifications v
    JOIN bookings b ON b.id = v.booking_id
    JOIN users u ON u.id = v.user_id
    ORDER BY v.submitted_at DESC, v.id DESC LIMIT 200
  `).all();
  const logs = await db.prepare(`
    SELECT booking_id AS bookingId, verification_id AS verificationId, actor_role AS actorRole,
      event, details, created_at AS createdAt FROM verification_logs ORDER BY created_at DESC LIMIT 200
  `).all();
  return { rows, logs };
}

async function submitClientVerification(request, response, user) {
  const body = await readBody(request);
  const bookingId = Number(body.bookingId);
  const documentType = String(body.documentType || "");
  const documentNumber = String(body.documentNumber || "");
  const documentName = String(body.documentName || "");
  if (!Number.isSafeInteger(bookingId) || bookingId < 1) {
    return sendJson(response, 400, { error: "Invalid booking id." });
  }
  if (!["aadhaar", "pan", "driver_license", "passport"].includes(documentType)) {
    return sendJson(response, 400, { error: "Choose a supported document type." });
  }
  if (!documentNumber.trim() || !documentName.trim()) {
    return sendJson(response, 400, { error: "Document number and file name are required." });
  }
  const booking = await db.prepare("SELECT id, user_id FROM bookings WHERE id = ?").get(bookingId);
  if (!booking || Number(booking.user_id) !== Number(user.id)) {
    return sendJson(response, 404, { error: "Booking not found for this account." });
  }
  const submitted = await statements.insertVerification.run(
    bookingId,
    user.id,
    documentType,
    documentNumber.trim(),
    documentName.trim(),
    "submitted",
    null,
    null,
    null
  );
  const verificationId = Number(submitted.lastInsertRowid);
  await statements.createVerificationLog.run(bookingId, verificationId, "client", user.id, "document_submitted", `Submitted ${documentType} document for verification`);
  return sendJson(response, 201, { id: verificationId, status: "submitted" });
}

async function updateDocumentSubmission(request, response) {
  const admin = await requireAdmin(request, response);
  if (!admin) return;
  const body = await readBody(request);
  const verificationId = Number(body.verificationId);
  const bookingId = Number(body.bookingId);
  const status = String(body.status || "");
  const remark = String(body.remark || "");
  if (!Number.isSafeInteger(verificationId) || verificationId < 1) {
    return sendJson(response, 400, { error: "Invalid verification id." });
  }
  if (!["submitted", "under_review", "verified", "rejected"].includes(status)) {
    return sendJson(response, 400, { error: "Choose a valid verification status." });
  }
  const verification = await db.prepare(`
    SELECT id, booking_id AS bookingId, user_id AS userId, document_type AS documentType, document_name AS documentName
    FROM document_verifications WHERE id = ?
  `).get(verificationId);
  if (!verification || Number(verification.bookingId) !== bookingId) {
    return sendJson(response, 404, { error: "Verification record not found." });
  }
  const reviewedAt = new Date().toISOString();
  await db.prepare(`
    UPDATE document_verifications
    SET status = ?, verification_result = ?, verified_by = ?, reviewed_at = ?
    WHERE id = ?
  `).run(status, remark || null, admin.id, reviewedAt, verificationId);
  await statements.createVerificationLog.run(bookingId, verificationId, "admin", admin.id, `document_${status}`, remark || "No review note provided");
  return sendJson(response, 200, { id: verificationId, bookingId, status });
}

async function logout(request, response) {
  const body = await readForm(request);
  const token = parseCookies(request.headers.cookie)[sessionsCookie];
  if (token) await statements.deleteSession.run(token);
  const destinations = new Set(["/", "/Index.html", "/Admin/login.html", "/Client/login.html"]);
  const destination = destinations.has(String(body.returnTo || ""))
    ? String(body.returnTo)
    : "/Admin/login.html";
  response.writeHead(303, {
    "Set-Cookie": `${sessionsCookie}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0`,
    Location: destination,
  });
  response.end();
}

function clientReturnPath(value) {
  const fallback = "/Client/dashboard.html";
  if (!value) return fallback;
  let destination;
  try {
    destination = new URL(String(value), "http://localhost");
  } catch {
    return fallback;
  }
  if (destination.origin !== "http://localhost") return fallback;
  if (destination.pathname === "/Client/dashboard.html" && !destination.search && !destination.hash) {
    return "/Client/dashboard.html";
  }
  if (destination.pathname === "/Index.html"
    && destination.search === "?resumeBooking=1"
    && destination.hash === "#booking") {
    return "/Index.html?resumeBooking=1#booking";
  }
  return fallback;
}

function authError(response, role, message, signup = false, next = "") {
  const page = role === "admin" ? "/Admin/login.html" : "/Client/login.html";
  const query = new URLSearchParams({
    error: message,
    ...(signup ? { mode: "signup" } : {}),
    ...(role === "client" && next ? { next: clientReturnPath(next) } : {}),
  });
  response.writeHead(303, { Location: `${page}?${query.toString()}` });
  response.end();
}

function resolvePublicFile(pathname) {
  const normalized = pathname === "/" ? "/Index.html" : pathname;
  const allowed = new Map([
    ["/Index.html", path.join(ROOT, "Index.html")],
    ["/index.html", path.join(ROOT, "Index.html")],
    ["/Admin/login.html", path.join(ROOT, "Admin", "login.html")],
    ["/Admin/dashboard.html", path.join(ROOT, "Admin", "dashboard.html")],
    ["/Super-Admin/dashboard.html", path.join(ROOT, "Super-Admin", "dashboard.html")],
    ["/Client/login.html", path.join(ROOT, "Client", "login.html")],
    ["/Client/dashboard.html", path.join(ROOT, "Client", "dashboard.html")],
  ]);
  const exact = allowed.get(normalized);
  if (exact && fs.existsSync(exact) && fs.statSync(exact).isFile()) return exact;
  if (!normalized.startsWith("/Assets/")) return null;
  const assetPath = path.resolve(ROOT, `.${normalized}`);
  if (!assetPath.startsWith(path.resolve(ROOT, "Assets") + path.sep)) return null;
  return fs.existsSync(assetPath) && fs.statSync(assetPath).isFile() ? assetPath : null;
}

function setSecurityHeaders(response) {
  response.setHeader("X-Content-Type-Options", "nosniff");
  response.setHeader("X-Frame-Options", "DENY");
  response.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
  response.setHeader("Cache-Control", "no-store");
}

function sendJson(response, statusCode, body) {
  response.writeHead(statusCode, { "Content-Type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(body));
}

function sendHtml(response, statusCode, body) {
  response.writeHead(statusCode, { "Content-Type": "text/html; charset=utf-8" });
  response.end(body);
}

function pageMessage(title, message, backLink) {
  return `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${escapeHtml(title)} - Travlish</title><body style="font:16px system-ui;background:#0c0d0f;color:#f7f7f7;min-height:100vh;display:grid;place-items:center"><main style="max-width:540px;padding:32px;background:#15171a;border:1px solid #333;border-radius:20px"><h1 style="color:#ffad57">${escapeHtml(title)}</h1><p>${escapeHtml(message)}</p><p><a style="color:#ffad57" href="${escapeHtml(backLink)}">Return to sign in</a></p></main></body></html>`;
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, character => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[character]);
}

server.on("close", () => pool.end());

startServer().catch(async error => {
  console.error("Could not start Travlish with Supabase Postgres:", error.message);
  await pool.end();
  process.exitCode = 1;
});
