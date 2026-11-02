const clientState = { bookings: [], documents: [] };

function clientApi(url) {
  return fetch(url, { credentials: "same-origin" }).then(async response => {
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(body.error || `Request failed (${response.status}).`);
    return body;
  });
}

function clientElement(tag, className, text) {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (text !== undefined) element.textContent = String(text);
  return element;
}

function clientDate(value) {
  if (!value) return "Date to be confirmed";
  const date = new Date(String(value).replace(" ", "T"));
  return Number.isNaN(date.getTime())
    ? String(value)
    : new Intl.DateTimeFormat("en-IN", { weekday: "short", month: "short", day: "numeric", year: "numeric" }).format(date);
}

function clientStatus(status) {
  return clientElement("span", `dashboard-status ${status}`, status.replaceAll("_", " "));
}

function clientNotice(message, isError = false) {
  const notice = document.getElementById("clientNotice");
  notice.textContent = message;
  notice.classList.toggle("is-error", isError);
}

function showClientSection(name) {
  document.querySelectorAll("[data-client-panel]").forEach(panel => {
    panel.hidden = panel.dataset.clientPanel !== name;
  });
  document.querySelectorAll("[data-client-section]").forEach(button => {
    const active = button.dataset.clientSection === name;
    button.classList.toggle("active", active);
    if (active) button.setAttribute("aria-current", "page");
    else button.removeAttribute("aria-current");
  });
}

function renderClientDashboard(data) {
  const { user, bookings, documents } = data;
  clientState.bookings = bookings;
  clientState.documents = documents;
  const firstName = user.name.trim().split(/\s+/)[0] || "traveller";
  document.title = `My trips | Travel(e)sh Holidays`;
  document.getElementById("clientName").textContent = user.name;
  document.getElementById("clientAvatar").textContent = firstName.charAt(0).toUpperCase();
  document.getElementById("welcomeName").textContent = firstName;
  document.getElementById("clientTodayLabel").textContent = new Intl.DateTimeFormat("en-IN", { weekday: "long", month: "long", day: "numeric", year: "numeric" }).format(new Date());
  const active = bookings.filter(booking => ["pending", "confirmed"].includes(booking.status)).length;
  document.getElementById("clientStatTotal").textContent = bookings.length;
  document.getElementById("clientStatActive").textContent = active;
  document.getElementById("clientStatCompleted").textContent = bookings.filter(booking => booking.status === "completed").length;
  document.getElementById("clientNavBookingCount").textContent = bookings.length;
  renderClientBookings();
  renderClientDocuments();
  renderLatestBooking();
}

function renderLatestBooking() {
  const container = document.getElementById("latestBooking");
  const title = document.getElementById("latestBookingTitle");
  const latest = clientState.bookings[0];
  container.replaceChildren();
  if (!latest) {
    title.textContent = "Ready when you are";
    container.append(clientElement("p", "", "Your booking requests will appear here after you send one."));
    const link = clientElement("a", "button", "Plan a journey ↗");
    link.href = "/Index.html#booking";
    container.append(link);
    return;
  }
  title.textContent = latest.car;
  const details = clientElement("p", "", `${clientDate(latest.pickupDate)} · ${latest.pickup} → ${latest.destination}`);
  const status = clientStatus(latest.status);
  const link = clientElement("button", "dashboard-text-button", "View booking details ↗");
  link.type = "button";
  link.addEventListener("click", () => showClientSection("trips"));
  container.append(details, status, link);
}

function renderClientBookings() {
  const list = document.getElementById("clientBookingRows");
  list.replaceChildren();
  clientState.bookings.forEach(booking => {
    const card = clientElement("article", "client-booking-card");
    const details = document.createElement("div");
    details.append(clientElement("h2", "", booking.car));
    details.append(clientElement("p", "", `Booking #${booking.id} · Requested ${clientDate(booking.createdAt)}`));
    details.append(clientElement("p", "", `${booking.pickup} → ${booking.destination}`));
    card.append(details, clientStatus(booking.status));
    const meta = clientElement("div", "client-booking-meta");
    meta.append(clientElement("span", "", `Pickup: ${clientDate(booking.pickupDate)}`));
    meta.append(clientElement("span", "", booking.handover));
    if (booking.duration) meta.append(clientElement("span", "", booking.duration));
    card.append(meta);
    list.append(card);
  });
  document.getElementById("clientBookingsEmpty").hidden = clientState.bookings.length > 0;
}

function renderClientDocuments() {
  const list = document.getElementById("clientDocumentRows");
  list.replaceChildren();
  clientState.documents.forEach(verification => {
    const card = clientElement("article", "client-document-card");
    const details = document.createElement("div");
    details.append(clientElement("strong", "", `${verification.documentType.replaceAll("_", " ")} · Booking #${verification.bookingId}`));
    details.append(clientElement("small", "", `${verification.documentName} · Submitted ${clientDate(verification.submittedAt)}`));
    card.append(details, clientStatus(verification.status));
    list.append(card);
  });
  document.getElementById("clientDocumentsEmpty").hidden = clientState.documents.length > 0;
}

document.querySelectorAll("[data-client-section]").forEach(button => {
  button.addEventListener("click", () => showClientSection(button.dataset.clientSection));
});

clientApi("/api/client/dashboard")
  .then(renderClientDashboard)
  .catch(error => clientNotice(error.message, true));
