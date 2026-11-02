const cars = [
  { name: "Mahindra Thar", fuel: "Petrol", regular: 6500, discount: 6000, description: "Adventure-ready SUV", image: "https://tse3.mm.bing.net/th/id/OIP.X6MJGzil-Qe0z9KqDtuEhgHaE8?r=0&rs=1&pid=ImgDetMain&o=7&rm=3", emoji: "🚙" },
  { name: "Mahindra XUV700", fuel: "Diesel", regular: 8000, discount: 7000, description: "Premium family SUV", image: "/Assets/Photos/Mahindra-XUV700.jpg", emoji: "🚘" },
  { name: "Mahindra Scorpio N", fuel: "Diesel", regular: 8000, discount: 7000, description: "Bold, spacious SUV", image: "https://img.autocarindia.com/ExtraImages/20240701053932_Mahindra%20Scorpio%20N%20showroom.jpg", emoji: "🚙" },
  { name: "Maruti Suzuki Baleno", fuel: "Petrol", regular: 3500, discount: 3000, description: "Comfortable city drive", image: "/Assets/Photos/Maruti-Baleno.jpg", emoji: "🚗" },
  { name: "Hyundai Grand i10 Nios", fuel: "CNG", regular: 4000, discount: 3500, description: "Compact and practical", image: "/Assets/Photos/Hyundai-i10-Nios.jpg", emoji: "🚗" },
  { name: "Hyundai Verna", fuel: "Petrol", regular: 5000, discount: 4500, description: "Sleek premium sedan", image: "/Assets/Photos/Hyundai-Verna.jpg", emoji: "🚘" },
  { name: "Maruti Suzuki Swift", fuel: "CNG", regular: 4000, discount: 3500, description: "Smart everyday ride", image: "https://tse3.mm.bing.net/th/id/OIP.09PkSPAi1_YG_tYnqH4iAwHaEK?r=0&rs=1&pid=ImgDetMain&o=7&rm=3", emoji: "🚗" },
  { name: "Hyundai Creta (Black)", fuel: "Diesel", regular: null, discount: null, description: "Black Hyundai Creta · large SUV", image: "/Assets/Photos/Hyundai-Creta-Black.jpg", emoji: "🚙" }
];

const money = amount => `₹${Number(amount).toLocaleString("en-IN")}`;
const escapeHtml = value => String(value ?? "").replace(/[&<>"']/g, character => ({
  "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
})[character]);

const menuToggle = document.getElementById("menuToggle");
const navLinks = document.getElementById("navLinks");
if (menuToggle && navLinks) {
  menuToggle.addEventListener("click", () => {
    const expanded = menuToggle.getAttribute("aria-expanded") === "true";
    menuToggle.setAttribute("aria-expanded", String(!expanded));
    navLinks.classList.toggle("open", !expanded);
  });
  navLinks.addEventListener("click", event => {
    if (event.target.closest("a")) {
      navLinks.classList.remove("open");
      menuToggle.setAttribute("aria-expanded", "false");
    }
  });
}

const carList = document.getElementById("carList");
const carSelect = document.getElementById("car");
if (carList && carSelect) {
  document.getElementById("fleetCount").textContent = `${String(cars.length).padStart(2, "0")} VEHICLES`;
  cars.forEach((car, index) => {
    const card = document.createElement("article");
    card.className = "car-card";
    const price = car.discount == null
      ? `<span class="price-now">Ask for price</span><span class="price-note">Contact us for a quote</span>`
      : `<span class="price-old">${money(car.regular)}</span><span class="price-now">${money(car.discount)}</span><span class="price-note">Special rate · duration to confirm</span>`;
    card.innerHTML = `
      <div class="car-image">
        <span class="car-emoji" aria-hidden="true">${car.emoji}</span>
        <img src="${escapeHtml(car.image)}" alt="${escapeHtml(car.name)}" loading="lazy">
      </div>
      <div class="car-info">
        <div class="car-meta"><span class="fuel">${escapeHtml(car.fuel)}</span><span>${car.discount == null ? "Quote" : "Special rate"}</span></div>
        <h3>${escapeHtml(car.name)}</h3>
        <p class="car-description">${escapeHtml(car.description)}</p>
        <div class="car-price"><div>${price}</div></div>
        <button class="car-book" type="button" data-car="${index}">Enquire about this car ↗</button>
      </div>`;
    const image = card.querySelector("img");
    image.addEventListener("load", () => card.querySelector(".car-image").classList.add("has-photo"));
    image.addEventListener("error", () => image.remove());
    carList.appendChild(card);

    const option = document.createElement("option");
    option.value = car.name;
    option.textContent = `${car.name} · ${car.discount == null ? "Price on request" : `${money(car.discount)} special rate`}`;
    carSelect.appendChild(option);
  });

  carList.addEventListener("click", event => {
    const button = event.target.closest("[data-car]");
    if (!button) return;
    carSelect.value = cars[Number(button.dataset.car)].name;
    document.getElementById("booking").scrollIntoView({ behavior: "smooth" });
    document.getElementById("customer").focus({ preventScroll: true });
  });
}

const bookingForm = document.getElementById("bookingForm");
if (bookingForm) {
  const status = document.getElementById("bookingStatus");
  const success = document.getElementById("bookingSuccess");
  const pickupDate = document.getElementById("pickupDate");
  const today = new Date();
  pickupDate.min = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-${String(today.getDate()).padStart(2, "0")}`;
  document.getElementById("year").textContent = new Date().getFullYear();

  const draftKey = "travlish_booking_draft";
  const pendingReturn = new URLSearchParams(location.search).get("resumeBooking") === "1";
  if (pendingReturn) {
    try {
      const saved = JSON.parse(sessionStorage.getItem(draftKey) || "null");
      if (saved && typeof saved === "object") {
        for (const [name, value] of Object.entries(saved)) {
          const field = bookingForm.elements.namedItem(name);
          if (field && typeof value === "string") field.value = value;
        }
        status.textContent = "Your booking details were restored. Review them and submit your request.";
      }
    } catch (error) {
      console.error("Could not restore the booking form:", error);
      status.textContent = "Your previous booking details could not be restored. Please fill the form again.";
      status.classList.add("error");
    } finally {
      sessionStorage.removeItem(draftKey);
    }
  }

  bookingForm.addEventListener("submit", async event => {
    event.preventDefault();
    success.classList.remove("visible");
    status.classList.remove("error");
    if (!bookingForm.reportValidity()) return;

    const formData = new FormData(bookingForm);
    const payload = Object.fromEntries(formData);
    const selectedCar = cars.find(car => car.name === payload.car);
    if (!selectedCar) {
      status.textContent = "Choose a vehicle to continue.";
      status.classList.add("error");
      return;
    }

    const submitButton = bookingForm.querySelector("[type=submit]");
    submitButton.disabled = true;
    status.textContent = "Sending your booking request…";
    try {
      const response = await fetch("/api/bookings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify(payload)
      });
      const result = await response.json();
      if (response.status === 401) {
        sessionStorage.setItem(draftKey, JSON.stringify(payload));
        const next = encodeURIComponent("/Index.html?resumeBooking=1#booking");
        location.assign(`/Client/login.html?next=${next}&error=${encodeURIComponent("Sign in to continue with your booking.")}`);
        return;
      }
      if (!response.ok) throw new Error(result.error || "We couldn't save your request. Please try again.");

      const message = [
        "Hello Travel(e)sh Holidays! I have submitted a car rental request.",
        `Reference: #${result.id}`,
        `Vehicle: ${selectedCar.name} (${selectedCar.fuel})`,
        selectedCar.discount == null ? "Listed rate: Please quote." : `Listed special rate: ${money(selectedCar.discount)}; duration to confirm`,
        `Name: ${payload.customer}`,
        `Phone: ${payload.phone}`,
        payload.email ? `Email: ${payload.email}` : "",
        `Pickup date: ${payload.pickupDate}`,
        `Handover: ${payload.handover}`,
        `Pickup: ${payload.pickup}`,
        `Destination: ${payload.destination}`,
        payload.duration ? `Duration: ${payload.duration}` : "",
        payload.notes ? `Notes: ${payload.notes}` : "",
        "Please confirm availability, final rate, rental terms and any additional charges."
      ].filter(Boolean).join("\n");
      document.getElementById("successRef").textContent = `Request #${result.id} is saved and waiting for agency review.`;
      document.getElementById("whatsappLink").href = `https://wa.me/917428149126?text=${encodeURIComponent(message)}`;
      success.classList.add("visible");
      status.textContent = "Your request is in. This is not a confirmed reservation or payment.";
      bookingForm.reset();
      pickupDate.min = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-${String(today.getDate()).padStart(2, "0")}`;
      success.scrollIntoView({ behavior: "smooth", block: "nearest" });
    } catch (error) {
      status.textContent = error.message || "A network error interrupted your request. Please try again.";
      status.classList.add("error");
    } finally {
      submitButton.disabled = false;
    }
  });
}
