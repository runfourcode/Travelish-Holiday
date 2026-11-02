const adminState = { data: null, documents: [] };
const adminStatusLabels = ["pending", "confirmed", "completed", "cancelled"];

function dashboardApi(url, options = {}) {
  return fetch(url, {
    credentials: "same-origin",
    ...options,
    headers: { ...(options.body ? { "Content-Type": "application/json" } : {}), ...options.headers },
  }).then(async response => {
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(body.error || `Request failed (${response.status}).`);
    return body;
  });
}

function adminNotice(message, isError = false) {
  const notice = document.getElementById("dashboardNotice");
  notice.textContent = message;
  notice.classList.toggle("is-error", isError);
}

function adminElement(tag, className, text) {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (text !== undefined) element.textContent = String(text);
  return element;
}

function adminCell(primary, secondary) {
  const cell = document.createElement("td");
  cell.append(adminElement("strong", "", primary));
  if (secondary) cell.append(adminElement("small", "", secondary));
  return cell;
}

function adminDate(value, options = { month: "short", day: "numeric", year: "numeric" }) {
  if (!value) return "—";
  const date = new Date(String(value).replace(" ", "T"));
  return Number.isNaN(date.getTime()) ? String(value) : new Intl.DateTimeFormat("en-IN", options).format(date);
}

function adminStatus(status) {
  return adminElement("span", `dashboard-status ${status}`, status.replaceAll("_", " "));
}

function adminMatches(...values) {
  const query = document.getElementById("dashboardSearch").value.trim().toLowerCase();
  return !query || values.some(value => String(value || "").toLowerCase().includes(query));
}

function showAdminSection(name) {
  document.querySelectorAll("[data-dashboard-panel]").forEach(panel => {
    panel.hidden = panel.dataset.dashboardPanel !== name;
  });
  document.querySelectorAll("[data-section-target]").forEach(button => {
    const active = button.dataset.sectionTarget === name;
    button.classList.toggle("active", active);
    if (active) button.setAttribute("aria-current", "page");
    else button.removeAttribute("aria-current");
  });
}

function renderAdminDashboard() {
  const { bookings, clients, staff, stats, user } = adminState.data;
  const label = user.isSuperAdmin ? "Super-admin" : "Admin";
  document.title = `${label} dashboard | Travel(e)sh Holidays`;
  document.getElementById("accountName").textContent = user.name;
  document.getElementById("accountRole").textContent = `${label} workspace`;
  document.getElementById("accountAvatar").textContent = user.name.trim().charAt(0).toUpperCase() || "A";
  document.getElementById("todayLabel").textContent = new Intl.DateTimeFormat("en-IN", { weekday: "long", month: "long", day: "numeric", year: "numeric" }).format(new Date());
  document.getElementById("statBookings").textContent = stats.bookings;
  document.getElementById("statPending").textContent = stats.enquiries;
  document.getElementById("statClients").textContent = stats.customers;
  document.getElementById("statDocuments").textContent = stats.documentChecks;
  document.getElementById("navBookingCount").textContent = stats.bookings;
  document.getElementById("navDocumentCount").textContent = stats.documentChecks;
  renderAdminBookings();
  renderAdminClients(clients);
  renderAdminStaff(staff);
  renderAdminDocuments();
  renderAdminStatusSummary(stats.statusCounts, stats.bookings);
}

function renderAdminBookings() {
  const bookings = adminState.data.bookings;
  const queryMatches = booking => adminMatches(
    booking.id, booking.customer, booking.phone, booking.email, booking.accountName,
    booking.accountEmail, booking.car, booking.pickup, booking.destination, booking.notes, booking.duration
  );
  const visible = bookings.filter(booking => {
    const status = document.getElementById("bookingStatusFilter").value;
    return (status === "all" || booking.status === status) && queryMatches(booking);
  });
  const rows = document.getElementById("bookingRows");
  rows.replaceChildren();
  visible.forEach(booking => {
    const row = document.createElement("tr");

    // Client & Contact info cell
    const clientCell = document.createElement("td");
    clientCell.append(adminElement("strong", "", `#${booking.id} · ${booking.customer}`));
    if (booking.phone) {
      clientCell.append(adminElement("small", "", `📞 ${booking.phone}`));
    }
    const email = booking.email || booking.accountEmail;
    if (email) {
      clientCell.append(adminElement("small", "", `✉ ${email}`));
    }
    row.append(clientCell);

    // Vehicle & Handover cell
    const carCell = document.createElement("td");
    carCell.append(adminElement("strong", "", booking.car));
    carCell.append(adminElement("small", "", booking.handover));
    if (booking.duration) {
      carCell.append(adminElement("small", "", `⏱ ${booking.duration}`));
    }
    row.append(carCell);

    // Route & Notes cell
    const routeCell = document.createElement("td");
    routeCell.append(adminElement("strong", "", adminDate(booking.pickupDate)));
    routeCell.append(adminElement("small", "", `📍 ${booking.pickup} → ${booking.destination}`));
    if (booking.notes) {
      routeCell.append(adminElement("small", "", `📝 "${booking.notes}"`));
    }
    row.append(routeCell);

    // Status & Quick Action cell
    const statusCell = document.createElement("td");
    const select = document.createElement("select");
    select.className = "dashboard-select";
    select.setAttribute("aria-label", `Update booking ${booking.id} status`);
    adminStatusLabels.forEach(status => {
      const option = adminElement("option", "", status.replaceAll("_", " "));
      option.value = status;
      option.selected = status === booking.status;
      select.append(option);
    });
    select.addEventListener("change", () => updateBookingStatus(booking.id, select.value, select));
    statusCell.append(select);

    const cleanPhone = String(booking.phone || "").replace(/\D/g, "");
    if (cleanPhone.length >= 10) {
      const waLink = document.createElement("a");
      waLink.href = `https://wa.me/${cleanPhone.length === 10 ? '91' + cleanPhone : cleanPhone}?text=${encodeURIComponent(`Hello ${booking.customer}, regarding your booking #${booking.id} for ${booking.car} with Travel(e)sh Holidays:`)}`;
      waLink.target = "_blank";
      waLink.rel = "noopener noreferrer";
      waLink.style.cssText = "display: block; margin-top: 6px; font-size: 0.65rem; color: #2e7d32; text-decoration: none; font-weight: 700;";
      waLink.textContent = "💬 WhatsApp";
      statusCell.append(waLink);
    }
    row.append(statusCell);
    rows.append(row);
  });
  document.getElementById("bookingsEmpty").hidden = visible.length > 0;

  const recent = bookings.filter(queryMatches).slice(0, 5);
  const overviewRows = document.getElementById("overviewBookingRows");
  overviewRows.replaceChildren();
  recent.forEach(booking => {
    const row = document.createElement("tr");
    row.append(adminCell(booking.customer, `#${booking.id} · ${booking.car}`));
    row.append(adminCell(adminDate(booking.pickupDate), `${booking.pickup} → ${booking.destination}`));
    const statusCell = document.createElement("td");
    statusCell.append(adminStatus(booking.status));
    row.append(statusCell);
    overviewRows.append(row);
  });
  document.getElementById("overviewBookingsEmpty").hidden = recent.length > 0;
}

function renderAdminClients(clients) {
  const rows = document.getElementById("clientRows");
  rows.replaceChildren();
  const visible = clients.filter(client => adminMatches(client.name, client.email));
  visible.forEach(client => {
    const row = document.createElement("tr");
    row.append(adminCell(client.name, `Client #${client.id}`));
    row.append(adminCell(client.email));
    row.append(adminCell(client.bookingCount));
    row.append(adminCell(adminDate(client.createdAt)));
    rows.append(row);
  });
  document.getElementById("clientsEmpty").hidden = visible.length > 0;
}

function renderAdminStaff(staff) {
  const list = document.getElementById("staffRows");
  list.replaceChildren();
  const visible = staff.filter(member => adminMatches(member.name, member.email));
  visible.forEach(member => {
    const item = adminElement("div", "dashboard-team-member");
    item.append(adminElement("span", "dashboard-avatar", member.name.trim().charAt(0).toUpperCase() || "A"));
    const identity = document.createElement("span");
    identity.append(adminElement("strong", "", member.name));
    identity.append(adminElement("small", "", member.email));
    item.append(identity);
    item.append(adminElement("span", "dashboard-team-role", member.isSuperAdmin ? "Super-admin" : "Admin"));
    list.append(item);
  });
  document.getElementById("staffEmpty").hidden = visible.length > 0;
}

function renderAdminStatusSummary(counts, total) {
  const list = document.getElementById("bookingStatusSummary");
  list.replaceChildren();
  adminStatusLabels.forEach(status => {
    const row = adminElement("div", "dashboard-status-row");
    row.append(adminElement("span", "", status));
    row.append(adminElement("strong", "", counts[status] || 0));
    const progress = adminElement("div", "dashboard-progress");
    const fill = document.createElement("span");
    fill.style.width = `${total ? Math.min(100, ((counts[status] || 0) / total) * 100) : 0}%`;
    progress.append(fill);
    row.append(progress);
    list.append(row);
  });
}

function maskDocumentNumber(value) {
  const text = String(value || "");
  return text.length <= 4 ? "••••" : `${"•".repeat(Math.min(10, text.length - 4))}${text.slice(-4)}`;
}

function renderAdminDocuments() {
  const list = document.getElementById("documentRows");
  list.replaceChildren();
  const visible = adminState.documents.filter(document => adminMatches(
    document.id, document.bookingId, document.customerName, document.customerEmail,
    document.car, document.documentType, document.documentName
  ));
  visible.forEach(verification => {
    const card = adminElement("article", "dashboard-review-card");
    const details = adminElement("div", "dashboard-review-details");
    details.append(adminElement("h2", "", `${verification.documentType.replaceAll("_", " ")} · Booking #${verification.bookingId}`));
    details.append(adminElement("p", "", `${verification.customerName} · ${verification.customerEmail}`));
    details.append(adminElement("p", "", `${verification.car} · ${verification.documentName}`));
    details.append(adminElement("p", "", `Number: ${maskDocumentNumber(verification.documentNumber)} · Submitted ${adminDate(verification.submittedAt)}`));
    details.append(adminStatus(verification.status));

    const form = adminElement("form", "dashboard-review-form");
    form.append(adminElement("label", "", "Review status"));
    const status = document.createElement("select");
    status.name = "status";
    status.setAttribute("aria-label", `Review status for document ${verification.id}`);
    ["submitted", "under_review", "verified", "rejected"].forEach(value => {
      const option = adminElement("option", "", value.replaceAll("_", " "));
      option.value = value;
      option.selected = value === verification.status;
      status.append(option);
    });
    form.querySelector("label").append(status);
    const remark = document.createElement("input");
    remark.name = "remark";
    remark.maxLength = 1000;
    remark.placeholder = "Optional note for the client";
    remark.setAttribute("aria-label", "Optional review note");
    form.append(remark);
    const save = adminElement("button", "button", "Save review");
    save.type = "submit";
    form.append(save);
    form.addEventListener("submit", event => {
      event.preventDefault();
      updateDocumentReview(verification, status.value, remark.value, save);
    });
    card.append(details, form);
    list.append(card);
  });
  document.getElementById("documentsEmpty").hidden = visible.length > 0;
}

async function updateBookingStatus(id, status, control) {
  control.disabled = true;
  try {
    await dashboardApi("/api/admin/bookings/status", {
      method: "POST",
      body: JSON.stringify({ id, status }),
    });
    await loadAdminDashboard();
    adminNotice(`Booking #${id} updated to ${status.replaceAll("_", " ")}.`);
  } catch (error) {
    control.disabled = false;
    adminNotice(error.message, true);
  }
}

async function updateDocumentReview(document, status, remark, button) {
  button.disabled = true;
  try {
    await dashboardApi(`/api/admin/document-verifications/${document.id}`, {
      method: "POST",
      body: JSON.stringify({ verificationId: document.id, bookingId: document.bookingId, status, remark }),
    });
    await loadAdminDashboard();
    adminNotice(`Document review for booking #${document.bookingId} saved.`);
  } catch (error) {
    button.disabled = false;
    adminNotice(error.message, true);
  }
}

async function loadAdminDashboard() {
  const [data, verificationData] = await Promise.all([
    dashboardApi("/api/admin/dashboard"),
    dashboardApi("/api/admin/document-verifications"),
  ]);
  adminState.data = data;
  adminState.documents = verificationData.rows;
  renderAdminDashboard();
}

document.querySelectorAll("[data-section-target], [data-open-section]").forEach(button => {
  button.addEventListener("click", () => showAdminSection(button.dataset.sectionTarget || button.dataset.openSection));
});
document.getElementById("dashboardSearch").addEventListener("input", () => {
  if (!adminState.data) return;
  renderAdminBookings();
  renderAdminClients(adminState.data.clients);
  renderAdminStaff(adminState.data.staff);
  renderAdminDocuments();
});
document.getElementById("bookingStatusFilter").addEventListener("change", renderAdminBookings);
document.getElementById("refreshDashboard").addEventListener("click", async event => {
  event.currentTarget.disabled = true;
  try {
    await loadAdminDashboard();
    adminNotice("Dashboard updated.");
  } catch (error) {
    adminNotice(error.message, true);
  } finally {
    event.currentTarget.disabled = false;
  }
});
document.getElementById("staffForm").addEventListener("submit", async event => {
  event.preventDefault();
  const form = event.currentTarget;
  const values = Object.fromEntries(new FormData(form));
  if (values.password !== values.confirmPassword) {
    adminNotice("The passwords do not match.", true);
    return;
  }
  const button = form.querySelector('button[type="submit"]');
  button.disabled = true;
  try {
    const result = await dashboardApi("/api/admin/users", {
      method: "POST",
      body: JSON.stringify(values),
    });
    form.reset();
    await loadAdminDashboard();
    adminNotice(`${result.role === "super_admin" ? "Super-admin" : "Admin"} account created for ${result.email}.`);
  } catch (error) {
    adminNotice(error.message, true);
  } finally {
    button.disabled = false;
  }
});

loadAdminDashboard().catch(error => adminNotice(error.message, true));

const validSections = ["overview", "bookings", "clients", "documents", "team"];
const initialSection = location.hash.replace("#", "");
if (validSections.includes(initialSection)) {
  showAdminSection(initialSection);
}
window.addEventListener("hashchange", () => {
  const target = location.hash.replace("#", "");
  if (validSections.includes(target)) showAdminSection(target);
});
