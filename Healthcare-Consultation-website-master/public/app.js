const savedCart = (() => {
  try {
    const cart = JSON.parse(localStorage.getItem("careconnect-cart") || "[]");
    return Array.isArray(cart) ? cart : [];
  } catch {
    return [];
  }
})();
const state = {
  departments: [], doctors: [], products: [], clinics: [], osmProviders: [], nearbyClinics: [],
  cart: savedCart, user: null, selectedDoctor: null, selectedAppointmentProvider: null, location: null, map: null,
  markers: null, locationRequestId: 0, osmSearchError: ""
};
const chatHistory = [];
const $ = selector => document.querySelector(selector);
const pageTitles = {
  dashboard: "Dashboard",
  doctors: "Doctors",
  nearby: "Nearby care",
  "ai-tools": "AI tools",
  "ml-service": "ML service",
  pharmacy: "Pharmacy",
  appointments: "My appointments"
};
const requestedPage = window.location.pathname.slice(1);
const currentPage = Object.hasOwn(pageTitles, requestedPage) ? requestedPage : "dashboard";
const currentPath = currentPage === "dashboard" && window.location.pathname === "/" ? "/dashboard" : window.location.pathname;
document.body.dataset.page = currentPage;
document.title = `CareConnect | ${pageTitles[currentPage]}`;
document.querySelectorAll("main > section[data-page]").forEach(section => {
  section.classList.toggle("page-active", section.dataset.page === currentPage);
});
document.querySelectorAll("nav a").forEach(link => {
  if (new URL(link.href).pathname === currentPath) link.setAttribute("aria-current", "page");
});
const navigateToPage = page => window.location.assign(`/${page}`);
const safeHttpsUrl = value => {
  try {
    const url = new URL(value);
    return url.protocol === "https:" ? url.href : "";
  } catch {
    return "";
  }
};
const escapeHtml = value => String(value ?? "").replace(/[&<>"']/g, character => ({
  "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
})[character]);
const assetPath = (item, type) => {
  const file = String(item.image || "").split("/").pop();
  const directory = type === "doctor" ? "doc" : type === "product" ? "dishes" : "dep";
  return `/admin/Res_img/${directory}/${encodeURIComponent(file)}`;
};
let csrfToken = null;
const loadCsrfToken = async () => {
  const response = await fetch("/api/csrf", { credentials: "same-origin" });
  csrfToken = (await response.json()).csrfToken;
};
// <input type="datetime-local"> has no timezone; send an unambiguous UTC instant instead.
const toIsoDate = value => {
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? value : parsed.toISOString();
};
const api = async (endpoint, options = {}, retried = false) => {
  const headers = { ...(options.headers || {}) };
  const unsafe = !["GET", "HEAD"].includes(String(options.method || "GET").toUpperCase());
  if (options.body && !(options.body instanceof FormData)) headers["Content-Type"] = "application/json";
  if (unsafe) {
    if (!csrfToken) await loadCsrfToken();
    headers["X-CSRF-Token"] = csrfToken;
  }
  const response = await fetch(`/api/${endpoint}`, { ...options, headers, credentials: "same-origin" });
  if (response.status === 403 && unsafe && !retried) {
    const failure = await response.clone().json().catch(() => ({}));
    if (failure.code === "CSRF") {
      csrfToken = null; // expired session token: fetch a fresh one and retry once
      return api(endpoint, options, true);
    }
  }
  if (unsafe && ["login", "register", "logout"].includes(endpoint)) csrfToken = null; // session was replaced
  if (response.status === 204) return null;
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || "Something went wrong.");
  return data;
};
const showToast = message => {
  const toast = $("#toast");
  toast.textContent = message;
  toast.classList.add("show");
  setTimeout(() => toast.classList.remove("show"), 3200);
};
const saveCart = () => {
  localStorage.setItem("careconnect-cart", JSON.stringify(state.cart));
  $("#cart-count").textContent = state.cart.reduce((sum, item) => sum + item.quantity, 0);
};
$("#auth-dialog").addEventListener("cancel", event => {
  if (!state.user) event.preventDefault();
});
async function saveUser(user) {
  if (state.user?.id !== user?.id) resetHealthChat();
  state.user = user;
  renderHeader();
  await loadAppointments();
  if (user?.isAdmin) await loadManagedClinics();
  else clearManagedClinics();
  if (!user) openAuth();
}
function renderHeader() {
  document.body.classList.toggle("auth-required", !state.user);
  $("#user-label").textContent = state.user ? `Hi, ${state.user.name.split(" ")[0]}` : "";
  $("#auth-button").textContent = state.user ? "Sign out" : "Sign in";
  $("#admin-clinics").hidden = !state.user?.isAdmin;
  $("#admin-bootstrap-section").hidden = !state.user?.canBootstrapAdmin;
}
function renderDepartments() {
  $("#department-grid").innerHTML = state.departments.map((department, index) => `
    <article class="department-card"><div class="department-icon">${["♥", "✦", "◌", "＋", "✚", "◆"][index % 6]}</div>
    <h3>${escapeHtml(department.title)}</h3><p>${escapeHtml(department.description)}</p></article>`).join("");
  $("#prediction-doctor").innerHTML = state.doctors.map(doctor =>
    `<option value="${doctor.id}">${escapeHtml(doctor.name)} · ${escapeHtml(doctor.specialty)}</option>`).join("");
  const specialtyOptions = [...new Set(state.doctors.map(doctor => doctor.specialty))];
  $("#nearby-specialty").innerHTML = '<option value="">All specialties</option>' +
    specialtyOptions.map(specialty => `<option value="${escapeHtml(specialty)}">${escapeHtml(specialty)}</option>`).join("");
  $("#clinic-form [name=doctorId]").innerHTML = state.doctors.map(doctor =>
    `<option value="${doctor.id}">${escapeHtml(doctor.name)} · ${escapeHtml(doctor.specialty)}</option>`).join("");
}
function renderDoctors() {
  const grid = $("#doctor-grid");
  if (!state.location) {
    grid.innerHTML = `<div class="doctor-location-prompt"><p class="empty">Share your location to see real doctors and dentists listed near you.</p>
      <button class="button button-primary" type="button" data-find-real-doctors>Find doctors near me</button></div>`;
    grid.querySelector("[data-find-real-doctors]").addEventListener("click", findMyLocation);
    return;
  }
  const radius = Number($("#nearby-radius").value);
  const specialty = $("#nearby-specialty").value;
  const doctors = CareConnectGeo.findNearby(
    state.osmProviders.filter(provider => provider.category === "healthcare"),
    state.location,
    radius,
    specialty
  );
  grid.innerHTML = doctors.length ? doctors.map(doctor => `
    <article class="nearby-card"><div><div class="doctor-meta">${escapeHtml(doctor.doctor.specialty)} · ${doctor.distanceKm.toFixed(1)} km away</div>
      <h3>${escapeHtml(doctor.name)}</h3><p>${escapeHtml(doctor.address)}</p>
      ${doctor.phone ? `<p><a href="tel:${escapeHtml(doctor.phone.replace(/[^\d+(). -]/g, ""))}">${escapeHtml(doctor.phone)}</a></p>` : ""}
      ${doctor.mapURI ? `<a href="${escapeHtml(doctor.mapURI)}" target="_blank" rel="noopener noreferrer">View OpenStreetMap listing</a>` : ""}</div></article>`).join("")
    : '<p class="empty">No nearby doctors or dentists were found in OpenStreetMap for this distance. Try a wider radius or another specialty.</p>';
}
function findMedicalStores() {
  if (!requireSignIn()) return;
  if (!state.location) {
    findMyLocation();
    return;
  }
  const button = $("#pharmacy-find-button");
  button.disabled = true;
  button.textContent = "Searching nearby stores...";
  $("#pharmacy-nearby-results").innerHTML = '<p class="empty">Refreshing nearby medical store listings…</p>';
  loadOpenStreetMapProviders(state.location).then(providers => {
    state.osmProviders = providers;
    state.osmSearchError = "";
    renderPharmacyStores();
    try {
      renderNearbyClinics();
    } catch (error) {
      showToast(error.message);
    }
  }).catch(error => {
    state.osmSearchError = error.message;
    renderPharmacyStores();
  }).finally(() => {
    button.disabled = false;
    button.textContent = "Refresh nearby stores";
  });
}
function renderPharmacyStores() {
  const results = $("#pharmacy-nearby-results");
  if (!state.location) {
    results.innerHTML = '<p class="empty">Share your location to find nearby medical stores.</p>';
    return;
  }
  const externalSearch = googleMapsFallback("pharmacies medical stores", "pharmacies and medical stores");
  if (state.osmSearchError) {
    results.innerHTML = `<p class="empty">${escapeHtml(state.osmSearchError)} Choose “Find stores near me” to try again.</p>${externalSearch}`;
    return;
  }
  const radius = Number($("#pharmacy-radius").value);
  const pharmacies = CareConnectGeo.findNearby(
    state.osmProviders.filter(provider => provider.category === "pharmacy"),
    state.location,
    radius
  );
  results.innerHTML = pharmacies.length ? `<p class="nearby-count">${pharmacies.length} nearby medical store${pharmacies.length === 1 ? "" : "s"} found within ${radius} km</p>
    <div class="pharmacy-nearby-list">${pharmacies.map(pharmacy => {
      const directions = new URL("https://www.openstreetmap.org/directions");
      directions.searchParams.set("engine", "fossgis_osrm_car");
      directions.searchParams.set("route", `${state.location.latitude},${state.location.longitude};${pharmacy.latitude},${pharmacy.longitude}`);
      return `<article class="pharmacy-nearby-card"><div class="pharmacy-nearby-icon" aria-hidden="true">+</div><div class="pharmacy-nearby-details">
        <span class="doctor-meta">${pharmacy.distanceKm.toFixed(1)} km away · OpenStreetMap listing</span>
        <h3>${escapeHtml(pharmacy.name)}</h3><p>${escapeHtml(pharmacy.address)}</p>
        ${pharmacy.phone ? `<p><a href="tel:${escapeHtml(pharmacy.phone.replace(/[^\d+(). -]/g, ""))}">${escapeHtml(pharmacy.phone)}</a></p>` : ""}
        ${pharmacy.openingHours ? `<p>Mapped hours: ${escapeHtml(pharmacy.openingHours)}</p>` : ""}
        <div class="pharmacy-nearby-links">${pharmacy.mapURI ? `<a href="${escapeHtml(pharmacy.mapURI)}" target="_blank" rel="noopener noreferrer">View store listing</a>` : ""}
          <a href="${escapeHtml(directions.href)}" target="_blank" rel="noopener noreferrer">Get directions</a></div></div></article>`;
    }).join("")}</div>`
    : `<p class="empty">No OpenStreetMap-listed medical stores were found within ${radius} km. Try a wider search radius or refresh your location.</p>${externalSearch}`;
}
function renderProducts() {
  $("#product-grid").innerHTML = state.products.map(product => `
    <article class="product-card"><img src="${assetPath(product, "product")}" alt="${escapeHtml(product.name)}">
    <h3>${escapeHtml(product.name)}</h3><p>${escapeHtml(product.description)}</p>
    <div class="product-bottom"><span class="price">$${Number(product.price).toFixed(2)}</span>
    <button class="button button-outline" data-add="${product.id}">Add to cart</button></div></article>`).join("");
  document.querySelectorAll("[data-add]").forEach(button => button.addEventListener("click", () => {
    const id = Number(button.dataset.add);
    const item = state.cart.find(entry => entry.productId === id);
    if (item) item.quantity += 1;
    else state.cart.push({ productId: id, quantity: 1 });
    saveCart();
    showToast("Added to your cart.");
  }));
}
async function loadAppointments() {
  if (!state.user) {
    $("#appointment-list").innerHTML = '<p class="empty">Sign in to see your appointments.</p>';
    renderAppointmentSuggestions();
    return;
  }
  try {
    const appointments = await api("appointments");
    $("#appointment-list").innerHTML = appointments.length ? appointments.map(appointment => `
      <div class="appointment-card"><div><strong>${escapeHtml(appointment.doctor?.name || appointment.providerName || "Doctor")}</strong>
      ${appointment.providerAddress ? `<p>${escapeHtml(appointment.providerAddress)}</p>` : ""}
      <p>${escapeHtml(new Date(appointment.date).toLocaleString())}${appointment.notes ? ` · ${escapeHtml(appointment.notes)}` : ""}</p>
      ${appointment.providerSource === "openstreetmap" ? '<p class="appointment-unconfirmed-note">Saved in your CareConnect list only. This request was not sent to the provider; contact them directly to confirm.</p>' : ""}
      </div><span class="status">${escapeHtml(appointment.status)}</span></div>`).join("") :
      '<p class="empty">You have no appointments yet. Choose a specialist above to get started.</p>';
    renderAppointmentSuggestions();
  } catch (error) {
    showToast(error.message);
  }
}
function renderAppointmentSuggestions() {
  const suggestions = $("#appointment-suggestions");
  if (!state.user) {
    suggestions.innerHTML = '<p class="empty">Sign in and share your location to see nearby doctor suggestions.</p>';
    return;
  }
  if (!state.location) {
    suggestions.innerHTML = '<p class="empty">Share your location to see nearby doctors and available booking options.</p>';
    return;
  }
  const radius = Number($("#appointment-radius").value);
  const providers = [
    ...state.clinics.map(clinic => ({ ...clinic, source: "careconnect" })),
    ...state.osmProviders.filter(provider => provider.category === "healthcare")
  ];
  const nearby = CareConnectGeo.findNearby(providers, state.location, radius);
  if (!nearby.length) {
    suggestions.innerHTML = `<p class="empty">No doctors or clinics were found within ${radius} km. Try a wider distance or refresh your location.</p>`;
    return;
  }
  suggestions.innerHTML = `<p class="nearby-count">${nearby.length} nearby doctor${nearby.length === 1 ? "" : "s"} or clinic${nearby.length === 1 ? "" : "s"} within ${radius} km</p>
    <div class="appointment-suggestion-list">${nearby.map(provider => {
      const bookable = state.doctors.some(doctor => doctor.id === provider.doctor.id);
      const directions = new URL("https://www.openstreetmap.org/directions");
      directions.searchParams.set("engine", "fossgis_osrm_car");
      directions.searchParams.set("route", `${state.location.latitude},${state.location.longitude};${provider.latitude},${provider.longitude}`);
      return `<article class="appointment-suggestion-card"><div class="appointment-suggestion-copy">
        <span class="doctor-meta">${provider.distanceKm.toFixed(1)} km away · ${provider.source === "openstreetmap" ? "OpenStreetMap listing" : "CareConnect clinic"}</span>
        <h4>${escapeHtml(provider.doctor.name)}</h4><p class="appointment-specialty">${escapeHtml(provider.doctor.specialty)}</p>
        ${provider.name && provider.name !== provider.doctor.name ? `<p><strong>${escapeHtml(provider.name)}</strong></p>` : ""}
        <p>${escapeHtml(provider.address || "Address not listed")}</p>
        ${provider.phone ? `<p><a href="tel:${escapeHtml(provider.phone.replace(/[^\d+(). -]/g, ""))}">${escapeHtml(provider.phone)}</a></p>` : ""}
        </div><div class="appointment-suggestion-actions">
          ${bookable ? `<button class="button button-primary" type="button" data-appointment-book="${provider.doctor.id}">Book appointment</button>` : ""}
          ${provider.source === "openstreetmap" ? `<button class="button button-primary" type="button" data-appointment-request="${escapeHtml(provider.id)}">Request a time</button>` : ""}
          <a class="button button-outline" href="${escapeHtml(directions.href)}" target="_blank" rel="noopener noreferrer">Get directions</a>
          ${safeHttpsUrl(provider.mapURI) ? `<a class="appointment-listing-link" href="${escapeHtml(safeHttpsUrl(provider.mapURI))}" target="_blank" rel="noopener noreferrer">View listing</a>` : ""}
        </div></article>`;
    }).join("")}</div>`;
  suggestions.querySelectorAll("[data-appointment-book]").forEach(button => {
    button.addEventListener("click", () => openBooking(Number(button.dataset.appointmentBook)));
  });
  suggestions.querySelectorAll("[data-appointment-request]").forEach(button => {
    button.addEventListener("click", () => openProviderAppointment(button.dataset.appointmentRequest));
  });
}
function openBooking(id) {
  if (!state.user) return openAuth("signin", "Please sign in before booking an appointment.");
  state.selectedDoctor = state.doctors.find(doctor => doctor.id === id);
  if (!state.selectedDoctor) return showToast("That doctor is no longer available.");
  state.selectedAppointmentProvider = null;
  $("#booking-title").textContent = "Book an appointment";
  $("#booking-doctor").textContent = `${state.selectedDoctor.name} · ${state.selectedDoctor.specialty} · $${state.selectedDoctor.fee}`;
  $("#booking-request-note").hidden = true;
  $("#booking-submit").textContent = "Confirm appointment";
  $("#booking-dialog").showModal();
}
function openProviderAppointment(providerId) {
  if (!requireSignIn()) return;
  const provider = state.osmProviders.find(item => String(item.id) === String(providerId) && item.category === "healthcare");
  if (!provider) return showToast("That nearby listing is no longer available. Refresh your location and try again.");
  state.selectedDoctor = null;
  state.selectedAppointmentProvider = provider;
  $("#booking-title").textContent = "Request an appointment time";
  $("#booking-doctor").textContent = `${provider.doctor.name} · ${provider.doctor.specialty} · ${provider.address}`;
  $("#booking-request-note").textContent = "This only saves your requested date and time in CareConnect. It does not contact or book the provider. Call or contact them directly to confirm availability.";
  $("#booking-request-note").hidden = false;
  $("#booking-submit").textContent = "Save requested time";
  $("#booking-dialog").showModal();
}
function openAuth(mode = "signin", message = "") {
  const isRegister = mode === "register";
  $("#auth-dialog").querySelector("[data-close]").hidden = !state.user;
  $("#auth-content").innerHTML = `<div class="auth-panel">
    <p class="eyebrow">CARECONNECT ACCOUNT</p><h2>${state.user ? "Welcome back" : "Sign in to your dashboard"}</h2>
    ${!state.user ? '<p class="auth-intro">Sign in or create an account to access your personal healthcare dashboard.</p>' : ""}
    <div class="auth-tabs">
    <button class="${!isRegister ? "active" : ""}" data-auth-mode="signin">Sign in</button>
    <button class="${isRegister ? "active" : ""}" data-auth-mode="register">Create account</button></div>
    ${message ? `<p class="doctor-meta">${escapeHtml(message)}</p>` : ""}
    <form id="auth-form">${isRegister ? '<label>Full name<input name="name" maxlength="100" required></label>' : ""}
    <label>Email<input name="email" type="email" required></label>${isRegister ? '<label>Phone<input name="phone" maxlength="40"></label>' : ""}
    <label>Password<input name="password" type="password" minlength="8" maxlength="128" required></label>
    <button class="button button-primary" type="submit">${isRegister ? "Create account" : "Sign in"}</button></form>`;
  if (!$("#auth-dialog").open) $("#auth-dialog").showModal();
  document.querySelectorAll("[data-auth-mode]").forEach(button => button.addEventListener("click", () => openAuth(button.dataset.authMode)));
  $("#auth-form").addEventListener("submit", async event => {
    event.preventDefault();
    const body = Object.fromEntries(new FormData(event.target));
    try {
      const result = await api(isRegister ? "register" : "login", { method: "POST", body: JSON.stringify(body) });
      await saveUser(result.user);
      $("#auth-dialog").close();
      navigateToPage("dashboard");
      showToast(isRegister ? "Welcome to CareConnect." : "Welcome back.");
    } catch (error) {
      showToast(error.message);
    }
  });
}
function renderCart() {
  const items = state.cart.map(item => ({ ...item, product: state.products.find(product => product.id === item.productId) })).filter(item => item.product);
  if (!items.length) {
    $("#cart-content").innerHTML = '<p class="empty">Your cart is empty.</p>';
    return;
  }
  const total = items.reduce((sum, item) => sum + item.product.price * item.quantity, 0);
  $("#cart-content").innerHTML = `${items.map(item => `
    <div class="cart-row"><span>${escapeHtml(item.product.name)}<br><small>$${Number(item.product.price).toFixed(2)} × ${item.quantity}</small></span>
    <button class="button button-outline" data-remove="${item.productId}">Remove</button></div>`).join("")}
    <p><strong>Total: $${total.toFixed(2)}</strong></p><button class="button button-primary" id="checkout-button">Place order</button>`;
  document.querySelectorAll("[data-remove]").forEach(button => button.addEventListener("click", () => {
    state.cart = state.cart.filter(item => item.productId !== Number(button.dataset.remove));
    saveCart();
    renderCart();
  }));
  $("#checkout-button").addEventListener("click", async () => {
    if (!state.user) {
      $("#cart-dialog").close();
      return openAuth("signin", "Please sign in before placing an order.");
    }
    try {
      await api("orders", { method: "POST", body: JSON.stringify({ items: state.cart }) });
      state.cart = [];
      saveCart();
      $("#cart-dialog").close();
      showToast("Order placed successfully.");
    } catch (error) {
      showToast(error.message);
    }
  });
}
function requireSignIn() {
  if (state.user) return true;
  openAuth("signin", "Please sign in to use this private AI tool.");
  return false;
}
function setLoading(form, loading, buttonText) {
  const button = form.querySelector('button[type="submit"]');
  if (button) {
    if (loading) button.dataset.originalText = button.textContent;
    button.disabled = loading;
    button.textContent = loading ? buttonText : button.dataset.originalText || button.textContent;
  }
}
function showRecommendation(result) {
  const matching = state.doctors.filter(doctor => doctor.specialty.toLowerCase() === result.specialty.toLowerCase());
  $("#recommendation-result").innerHTML = `<div class="result-panel"><strong>Suggested specialty: ${escapeHtml(result.specialty)}</strong>
    <p>${escapeHtml(result.rationale)}</p><p>Suggested timing: <b>${escapeHtml(result.urgency)}</b></p>
    ${matching.length ? `<p>Available specialists: ${matching.map(doctor => escapeHtml(doctor.name)).join(", ")}</p>` : ""}
    <small>${escapeHtml(result.disclaimer)}</small></div>`;
}
function showNoShowEstimate(result) {
  $("#no-show-result").innerHTML = `<div class="result-panel"><strong>${result.probability}% estimated no-show probability · ${escapeHtml(result.risk)} risk</strong>
    <ul>${result.factors.map(factor => `<li>${escapeHtml(factor)}</li>`).join("")}</ul>
    <small>${escapeHtml(result.disclaimer)}</small></div>`;
}
function showDocumentSummary(result) {
  $("#document-result").innerHTML = `<div class="result-panel"><strong>Plain-language summary</strong><p>${escapeHtml(result.summary)}</p>
    ${result.keyFindings.length ? `<strong>Key findings</strong><ul>${result.keyFindings.map(item => `<li>${escapeHtml(item)}</li>`).join("")}</ul>` : ""}
    ${result.questions.length ? `<strong>Questions for your clinician</strong><ul>${result.questions.map(item => `<li>${escapeHtml(item)}</li>`).join("")}</ul>` : ""}
    <small>${escapeHtml(result.disclaimer)}</small></div>`;
}
function resetHealthChat() {
  chatHistory.length = 0;
  $("#chat-form").reset();
  $("#chat-file-name").textContent = "No file selected";
  $("#chat-messages").replaceChildren();
  addHealthChatMessage("assistant", "Hi. I can share general health information or help explain a document. Please avoid including your name or other identifying details. For emergencies, contact local emergency services now.");
}
function addHealthChatMessage(role, content, careTiming) {
  const message = document.createElement("article");
  message.className = `chat-message ${role === "assistant" ? "assistant-message" : "user-message"}`;
  const speaker = document.createElement("strong");
  speaker.textContent = role === "assistant" ? "CareConnect AI" : "You";
  message.append(speaker);
  const body = document.createElement("p");
  body.textContent = content;
  message.append(body);
  if (careTiming) {
    const timing = document.createElement("strong");
    timing.className = `chat-timing timing-${careTiming}`;
    timing.textContent = {
      emergency: "Care timing: seek emergency help now",
      "same-day": "Care timing: contact a clinician today",
      routine: "Care timing: routine information"
    }[careTiming];
    message.append(timing);
    const disclaimer = document.createElement("small");
    disclaimer.textContent = "This is a cautious AI suggestion, not a diagnosis or a substitute for professional advice.";
    message.append(disclaimer);
  }
  $("#chat-messages").append(message);
  $("#chat-messages").scrollTop = $("#chat-messages").scrollHeight;
}
function showPrescriptionRead(result) {
  const medicines = result.medicines.length
    ? `<div class="table-wrap"><table><thead><tr><th>Medicine on document</th><th>Prescribed quantity</th><th>Catalogue match and rate</th><th>Estimated total</th></tr></thead><tbody>
      ${result.medicines.map(medicine => `<tr><td>${escapeHtml(medicine.name)}${medicine.strength ? ` · ${escapeHtml(medicine.strength)}` : ""}</td>
        <td>${medicine.quantity === null ? "Not clearly stated" : `${medicine.quantity}${medicine.quantityUnit ? ` ${escapeHtml(medicine.quantityUnit)}` : ""}`}</td>
        <td>${medicine.product ? `${escapeHtml(medicine.product.name)} · $${medicine.product.rate.toFixed(2)} per listed unit` : "No exact match in the current store catalogue"}</td>
        <td>${medicine.product && medicine.product.lineTotal !== null ? `$${medicine.product.lineTotal.toFixed(2)}` : "Unavailable"}</td></tr>`).join("")}
      </tbody></table></div>`
    : "<p>No clearly readable medicine names were found. Check the image or text and try again.</p>";
  $("#document-result").innerHTML = `<div class="result-panel"><strong>Medicines read from your document</strong>${medicines}<small>${escapeHtml(result.disclaimer)}</small></div>`;
}
function clearManagedClinics() {
  $("#managed-clinics").replaceChildren();
  $("#clinic-form").reset();
  $("#clinic-form [name=clinicId]").value = "";
  $("#clinic-form button[type=submit]").textContent = "Add clinic";
  $("#cancel-clinic-edit").hidden = true;
}
function renderManagedClinics() {
  $("#managed-clinics").innerHTML = state.clinics.length ? state.clinics.map(clinic => `
    <article class="managed-clinic"><div><strong>${escapeHtml(clinic.name)} · ${escapeHtml(clinic.doctor.name)}</strong>
      <p>${escapeHtml(clinic.address)}</p><p>${clinic.verified ? "Published in nearby search" : "Needs pin review before publishing"}</p>
      <a href="https://www.openstreetmap.org/?mlat=${clinic.latitude}&mlon=${clinic.longitude}#map=17/${clinic.latitude}/${clinic.longitude}" target="_blank" rel="noopener noreferrer">Preview this map pin on OpenStreetMap</a></div>
      <div class="managed-clinic-actions">${clinic.verified ? "" : `<button class="button button-primary" data-publish-clinic="${clinic.id}">Confirm pin and publish</button>`}
      <button class="button button-outline" data-edit-clinic="${clinic.id}">Edit</button>
      <button class="button button-outline" data-delete-clinic="${clinic.id}">Remove</button></div></article>`).join("") :
    '<p class="empty">No clinic addresses are registered yet. Add a real clinic address to make this doctor discoverable by nearby patients.</p>';
  document.querySelectorAll("[data-edit-clinic]").forEach(button => button.addEventListener("click", () => {
    const clinic = state.clinics.find(item => item.id === Number(button.dataset.editClinic));
    if (!clinic) return;
    const form = $("#clinic-form");
    form.elements.clinicId.value = clinic.id;
    form.elements.name.value = clinic.name;
    form.elements.doctorId.value = clinic.doctorId;
    form.elements.address.value = clinic.address;
    form.querySelector('button[type="submit"]').textContent = "Save clinic";
    $("#cancel-clinic-edit").hidden = false;
    form.scrollIntoView({ behavior: "smooth", block: "center" });
  }));
  document.querySelectorAll("[data-delete-clinic]").forEach(button => button.addEventListener("click", async () => {
    if (!window.confirm("Remove this clinic from nearby doctor search?")) return;
    try {
      await api(`admin/clinics/${button.dataset.deleteClinic}`, { method: "DELETE" });
      await refreshClinicDirectory();
    } catch (error) {
      showToast(error.message);
    }
  }));
  document.querySelectorAll("[data-publish-clinic]").forEach(button => button.addEventListener("click", async () => {
    if (!window.confirm("Have you checked that the clinic address and map pin are correct? Publishing makes this location visible to patients.")) return;
    try {
      await api(`admin/clinics/${button.dataset.publishClinic}/verify`, { method: "POST" });
      await refreshClinicDirectory();
      showToast("Verified clinic is now visible in nearby search.");
    } catch (error) {
      showToast(error.message);
    }
  }));
}
async function loadManagedClinics() {
  try {
    state.clinics = await api("admin/clinics");
    renderManagedClinics();
  } catch (error) {
    if (error.message !== "Administrator access is required.") showToast(error.message);
  }
}
async function refreshClinicDirectory() {
  state.clinics = await api("admin/clinics");
  renderManagedClinics();
  await loadPublicClinics();
  if (state.location) renderNearbyClinics();
}
async function loadPublicClinics() {
  state.clinics = await api("clinics");
}
function loadOpenStreetMapProviders(origin) {
  return api("nearby", {
    method: "POST",
    body: JSON.stringify({ latitude: origin.latitude, longitude: origin.longitude })
  });
}
function googleMapsSearchUrl(query, location) {
  const search = new URL("https://www.google.com/maps/search/");
  search.searchParams.set("api", "1");
  search.searchParams.set("query", `${query} near ${location.latitude},${location.longitude}`);
  return search.href;
}
function googleMapsFallback(query, categoryLabel) {
  if (!state.location) return "";
  return `<p class="pharmacy-map-fallback">OpenStreetMap listings can be incomplete. <a href="${escapeHtml(googleMapsSearchUrl(query, state.location))}" target="_blank" rel="noopener noreferrer" data-google-maps-search>Search Google Maps for ${escapeHtml(categoryLabel)} near your location</a>. This opens Google Maps and sends your search location to Google.</p>`;
}
function locationErrorMessage(error) {
  if (error.code === 1) return "Location permission was denied. You can still browse doctors without nearby sorting.";
  if (error.code === 2) return "Your location could not be determined. Check your device location settings and try again.";
  if (error.code === 3) return "Location lookup timed out. Try again when your device has a clearer GPS signal.";
  return "Your browser could not access location. Open this site on localhost or over HTTPS, then try again.";
}
function createMap() {
  const mapElement = $("#clinic-map");
  mapElement.hidden = false;
  if (!state.map) {
    if (!window.L) throw new Error("The OpenStreetMap map library could not load. Check your internet connection and refresh.");
    state.map = L.map(mapElement).setView([state.location.latitude, state.location.longitude], 13);
    L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
      maxZoom: 19,
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener noreferrer">OpenStreetMap contributors</a>'
    }).addTo(state.map);
    state.markers = L.layerGroup().addTo(state.map);
  }
  state.markers.clearLayers();
  const locations = [[state.location.latitude, state.location.longitude]];
  L.circleMarker(locations[0], { radius: 8, color: "#0f766e", fillColor: "#14b8a6", fillOpacity: 1 })
    .bindPopup("Your location")
    .addTo(state.markers);
  state.nearbyClinics.forEach((clinic, index) => {
    const position = [clinic.latitude, clinic.longitude];
    locations.push(position);
    L.marker(position, { title: `${clinic.name || clinic.doctor.name} · ${clinic.doctor.specialty}` })
      .bindPopup(`<strong>${escapeHtml(index + 1)}. ${escapeHtml(clinic.name || clinic.doctor.name)}</strong><br>${escapeHtml(clinic.doctor.specialty)}`)
      .addTo(state.markers);
  });
  state.map.fitBounds(L.latLngBounds(locations).pad(0.12), { maxZoom: 14 });
  state.map.invalidateSize();
}
function renderNearbyClinics() {
  const radius = Number($("#nearby-radius").value);
  const category = $("#nearby-category").value;
  const specialty = $("#nearby-specialty").value;
  const providers = [
    ...state.clinics.map(clinic => ({ ...clinic, source: "careconnect" })),
    ...state.osmProviders
  ];
  const matchingCategory = CareConnectGeo.filterByCategory(providers, category);
  state.nearbyClinics = CareConnectGeo.findNearby(
    matchingCategory,
    state.location,
    radius,
    category === "pharmacy" ? "" : specialty
  );
  renderDoctors();
  renderAppointmentSuggestions();
  const directory = $("#nearby-content");
  if (!providers.length) {
    directory.innerHTML = `<p class="empty">No OpenStreetMap-listed providers were returned. Try refreshing your location.</p>${googleMapsFallback("hospitals doctors clinics dentists", "hospitals and doctors")}`;
    $("#nearby-controls").hidden = true;
    $("#clinic-map").hidden = true;
    return;
  }
  $("#nearby-controls").hidden = false;
  const specialtyOptions = [...new Set(providers
    .filter(provider => provider.category !== "pharmacy")
    .map(provider => provider.doctor.specialty))];
  const specialtySelect = $("#nearby-specialty");
  if (specialtySelect.options.length !== specialtyOptions.length + 1 ||
      specialtyOptions.some(value => !Array.from(specialtySelect.options).some(option => option.value === value))) {
    specialtySelect.innerHTML = '<option value="">All specialties</option>' +
      specialtyOptions.map(value => `<option value="${escapeHtml(value)}">${escapeHtml(value)}</option>`).join("");
    specialtySelect.value = specialtyOptions.includes(specialty) ? specialty : "";
  }
  specialtySelect.disabled = category === "pharmacy";
  if (!matchingCategory.length) {
    directory.innerHTML = category === "pharmacy"
      ? `<p class="empty">No OpenStreetMap-listed medical stores were found. Try another type or share a different location.</p>${googleMapsFallback("pharmacies medical stores", "pharmacies and medical stores")}`
      : `<p class="empty">No OpenStreetMap-listed healthcare providers were found. Try another type or share a different location.</p>${googleMapsFallback("hospitals doctors clinics dentists", "hospitals and doctors")}`;
    $("#clinic-map").hidden = true;
    return;
  }
  const resultLabel = category === "pharmacy" ? "medical store" : category === "healthcare" ? "healthcare provider" : "provider";
  directory.innerHTML = `${state.nearbyClinics.length ? `<p class="nearby-count">${state.nearbyClinics.length} nearby ${resultLabel}${state.nearbyClinics.length === 1 ? "" : "s"} found</p>
    <div class="nearby-list">${state.nearbyClinics.map(clinic => `<article class="nearby-card ${clinic.category === "pharmacy" ? "pharmacy-result" : ""}">
      <div><span class="doctor-meta">${escapeHtml(clinic.doctor.specialty)} · ${clinic.distanceKm.toFixed(1)} km away${clinic.category === "pharmacy" ? " · Medical store" : ""}</span>
      <h3>${escapeHtml(clinic.doctor.name)}</h3>${clinic.name && clinic.name !== clinic.doctor.name ? `<strong>${escapeHtml(clinic.name)}</strong>` : ""}<p>${escapeHtml(clinic.address)}</p>
      ${clinic.phone ? `<p><a href="tel:${escapeHtml(clinic.phone.replace(/[^\d+(). -]/g, ""))}">${escapeHtml(clinic.phone)}</a></p>` : ""}
      ${clinic.openingHours ? `<p>Hours listed: ${escapeHtml(clinic.openingHours)}</p>` : ""}
      ${safeHttpsUrl(clinic.mapURI) ? `<a href="${escapeHtml(safeHttpsUrl(clinic.mapURI))}" target="_blank" rel="noopener noreferrer">View OpenStreetMap listing</a>` : ""}</div>
      <div class="nearby-actions"><button class="button button-outline" data-route-clinic="${escapeHtml(clinic.id)}">Open driving directions</button>
      ${clinic.doctor.id ? `<button class="button button-primary" data-book="${clinic.doctor.id}">Book this doctor</button>` :
        clinic.category === "healthcare" && clinic.source === "openstreetmap" ? `<button class="button button-primary" data-request-provider="${escapeHtml(clinic.id)}">Request a time</button>` : ""}</div></article>`).join("")}</div>` :
    '<p class="empty">No providers match this specialty and distance. Try another filter or a wider radius.</p>'}`;
  if (!state.nearbyClinics.length) {
    directory.insertAdjacentHTML("beforeend", category === "pharmacy"
      ? googleMapsFallback("pharmacies medical stores", "pharmacies and medical stores")
      : googleMapsFallback("hospitals doctors clinics dentists", "hospitals and doctors"));
  }
  document.querySelectorAll("[data-route-clinic]").forEach(button => button.addEventListener("click", () => showDrivingRoute(button.dataset.routeClinic, button)));
  document.querySelectorAll("#nearby-content [data-book]").forEach(button => button.addEventListener("click", () => openBooking(Number(button.dataset.book))));
  document.querySelectorAll("#nearby-content [data-request-provider]").forEach(button => button.addEventListener("click", () => openProviderAppointment(button.dataset.requestProvider)));
  createMap();
}
async function showDrivingRoute(clinicId, button) {
  const clinic = state.nearbyClinics.find(item => String(item.id) === String(clinicId));
  if (!clinic || !state.location) return showToast("Refresh your location and try the route again.");
  const route = new URL("https://www.openstreetmap.org/directions");
  route.searchParams.set("engine", "fossgis_osrm_car");
  route.searchParams.set("route", `${state.location.latitude},${state.location.longitude};${clinic.latitude},${clinic.longitude}`);
  window.open(route.href, "_blank", "noopener,noreferrer");
  $("#route-status").textContent = "Driving directions opened in OpenStreetMap. Route availability and travel estimates are provided by its routing service.";
}
$("#auth-button").addEventListener("click", async () => {
  if (!state.user) return openAuth();
  try {
    await api("logout", { method: "POST" });
    clearLocation();
    await saveUser(null);
    showToast("You have signed out.");
  } catch (error) {
    showToast(error.message);
  }
});
$("#cart-button").addEventListener("click", () => {
  renderCart();
  $("#cart-dialog").showModal();
});
$("#pharmacy-find-button").addEventListener("click", findMedicalStores);
$("#pharmacy-radius").addEventListener("change", renderPharmacyStores);
$("#locate-button").addEventListener("click", findMyLocation);
$("#appointment-locate-button").addEventListener("click", findMyLocation);
$("#appointment-radius").addEventListener("change", renderAppointmentSuggestions);
$("#nearby-specialty").addEventListener("change", renderNearbyClinics);
$("#nearby-category").addEventListener("change", renderNearbyClinics);
$("#nearby-radius").addEventListener("change", renderNearbyClinics);
document.querySelectorAll("[data-close]").forEach(button => button.addEventListener("click", () => button.closest("dialog").close()));
$("#confirm-location-button").addEventListener("click", () => {
  $("#location-consent-dialog").close();
  requestUserLocation();
});
$("#decline-location-button").addEventListener("click", () => {
  $("#location-consent-dialog").close();
});
$("#clinic-form").addEventListener("submit", async event => {
  event.preventDefault();
  if (!state.user?.isAdmin) return showToast("Administrator access is required.");
  const form = event.currentTarget;
  const body = Object.fromEntries(new FormData(form));
  const clinicId = body.clinicId;
  delete body.clinicId;
  setLoading(form, true, "Checking clinic address...");
  try {
    await api(clinicId ? `admin/clinics/${clinicId}` : "admin/clinics", {
      method: clinicId ? "PUT" : "POST",
      body: JSON.stringify(body)
    });
    clearManagedClinics();
    await refreshClinicDirectory();
    showToast("Clinic location saved.");
  } catch (error) {
    showToast(error.message);
  } finally {
    setLoading(form, false);
  }
});
$("#admin-bootstrap-form").addEventListener("submit", async event => {
  event.preventDefault();
  const form = event.currentTarget;
  setLoading(form, true, "Verifying setup token...");
  try {
    const result = await api("admin/bootstrap", {
      method: "POST",
      body: JSON.stringify({ setupToken: new FormData(form).get("setupToken") })
    });
    form.reset();
    await saveUser(result.user);
    showToast("Administrator access activated.");
  } catch (error) {
    showToast(error.message);
  } finally {
    setLoading(form, false);
  }
});
$("#cancel-clinic-edit").addEventListener("click", clearManagedClinics);
$("#booking-form").addEventListener("submit", async event => {
  event.preventDefault();
  const body = Object.fromEntries(new FormData(event.target));
  if (body.date) body.date = toIsoDate(body.date);
  if (state.selectedDoctor) {
    body.doctorId = state.selectedDoctor.id;
  } else if (state.selectedAppointmentProvider) {
    body.providerName = state.selectedAppointmentProvider.doctor.name;
    body.providerAddress = state.selectedAppointmentProvider.address;
    body.providerSource = state.selectedAppointmentProvider.source;
    body.providerCategory = state.selectedAppointmentProvider.category;
  } else {
    showToast("Choose a doctor or nearby healthcare provider first.");
    return;
  }
  try {
    await api("appointments", { method: "POST", body: JSON.stringify(body) });
    const externalRequest = Boolean(state.selectedAppointmentProvider);
    $("#booking-dialog").close();
    event.target.reset();
    await loadAppointments();
    navigateToPage("appointments");
    state.selectedAppointmentProvider = null;
    showToast(externalRequest
      ? "Requested time saved in your list. Contact the provider directly to confirm."
      : "Appointment booked successfully.");
  } catch (error) {
    showToast(error.message);
  }
});
$("#recommendation-form").addEventListener("submit", async event => {
  event.preventDefault();
  if (!requireSignIn()) return;
  const form = event.currentTarget;
  setLoading(form, true, "Checking available models...");
  $("#recommendation-result").textContent = "";
  try {
    showRecommendation(await api("ml/recommendations", {
      method: "POST",
      body: JSON.stringify({ symptoms: new FormData(form).get("symptoms") })
    }));
  } catch (error) {
    showToast(error.message);
  } finally {
    setLoading(form, false);
  }
});
$("#no-show-form").addEventListener("submit", async event => {
  event.preventDefault();
  if (!requireSignIn()) return;
  const form = event.currentTarget;
  setLoading(form, true, "Estimating...");
  $("#no-show-result").textContent = "";
  try {
    const body = Object.fromEntries(new FormData(form));
    if (body.date) body.date = toIsoDate(body.date);
    showNoShowEstimate(await api("ml/no-show", { method: "POST", body: JSON.stringify(body) }));
  } catch (error) {
    showToast(error.message);
  } finally {
    setLoading(form, false);
  }
});
$("#document-form").addEventListener("submit", async event => {
  event.preventDefault();
  if (!requireSignIn()) return;
  const form = event.currentTarget;
  const text = $("#document-text").value.trim();
  const file = $("#document-file").files[0];
  if (Boolean(text) === Boolean(file)) {
    showToast("Paste document text or choose one file, not both.");
    return;
  }
  setLoading(form, true, "Sending to Gemini...");
  $("#document-result").textContent = "";
  try {
    const result = await api("ml/documents", { method: "POST", body: new FormData(form) });
    if ($("#document-mode").value === "prescription") showPrescriptionRead(result);
    else showDocumentSummary(result);
  } catch (error) {
    showToast(error.message);
  } finally {
    setLoading(form, false);
  }
});
$("#chat-file").addEventListener("change", event => {
  const file = event.currentTarget.files[0];
  $("#chat-file-name").textContent = file ? `${file.name} · ${(file.size / (1024 * 1024)).toFixed(2)} MB` : "No file selected";
});
$("#chat-clear").addEventListener("click", resetHealthChat);
$("#chat-form").addEventListener("submit", async event => {
  event.preventDefault();
  if (!requireSignIn()) return;
  const form = event.currentTarget;
  const formData = new FormData(form);
  const message = String(formData.get("message") || "").trim();
  const file = $("#chat-file").files[0];
  if (!message && !file) {
    showToast("Enter a message or attach a document.");
    return;
  }
  const userId = state.user.id;
  const displayedMessage = message || "Please explain the attached document.";
  formData.set("message", message);
  formData.set("history", JSON.stringify(chatHistory.slice(-12)));
  const pending = document.createElement("p");
  pending.className = "chat-pending";
  pending.textContent = "CareConnect AI is preparing a response...";
  $("#chat-messages").append(pending);
  $("#chat-messages").scrollTop = $("#chat-messages").scrollHeight;
  setLoading(form, true, "Sending...");
  $("#chat-clear").disabled = true;
  try {
    const result = await api("ml/chat", { method: "POST", body: formData });
    if (!state.user || state.user.id !== userId) return;
    pending.remove();
    addHealthChatMessage("user", file ? `${displayedMessage}\n[Attached: ${file.name}]` : displayedMessage);
    addHealthChatMessage("assistant", result.reply, result.careTiming);
    chatHistory.push(
      { role: "user", content: displayedMessage },
      { role: "assistant", content: result.reply }
    );
    while (chatHistory.length > 12 || chatHistory.reduce((total, turn) => total + turn.content.length, 0) > 12000) {
      chatHistory.splice(0, 2);
    }
    form.reset();
    $("#chat-file-name").textContent = "No file selected";
  } catch (error) {
    pending.remove();
    showToast(error.message);
  } finally {
    setLoading(form, false);
    $("#chat-clear").disabled = false;
  }
});
function findMyLocation() {
  if (!requireSignIn()) return;
  $("#location-consent-dialog").showModal();
}
function requestUserLocation() {
  if (!requireSignIn()) return;
  if (!navigator.geolocation) {
    showToast("This browser does not support location access.");
    return;
  }
  const button = $("#locate-button");
  const requestId = ++state.locationRequestId;
  button.disabled = true;
  button.textContent = "Searching nearby providers...";
  $("#nearby-content").innerHTML = '<p class="empty">Getting your location and searching OpenStreetMap for nearby doctors and medical stores…</p>';
  navigator.geolocation.getCurrentPosition(async position => {
    if (!state.user || requestId !== state.locationRequestId) return;
    state.location = { latitude: position.coords.latitude, longitude: position.coords.longitude };
    button.disabled = false;
    button.textContent = "Refresh nearby doctors";
    const results = await Promise.allSettled([
      api("clinics"),
      loadOpenStreetMapProviders(state.location)
    ]);
    if (!state.user || requestId !== state.locationRequestId) return;
    state.clinics = results[0].status === "fulfilled" ? results[0].value : [];
    state.osmProviders = results[1].status === "fulfilled" ? results[1].value : [];
    state.osmSearchError = results[1].status === "rejected" ? results[1].reason.message : "";
    try {
      renderNearbyClinics();
      renderPharmacyStores();
      renderAppointmentSuggestions();
    } catch (error) {
      showToast(error.message);
    }
    if (results[0].status === "rejected") showToast(results[0].reason.message);
    if (results[1].status === "rejected") showToast(results[1].reason.message);
    $("#route-status").textContent = "Nearby listings are from OpenStreetMap contributors and may be incomplete or outdated. Your location is sent to OpenStreetMap for this search and is not saved by CareConnect.";
  }, error => {
    if (!state.user || requestId !== state.locationRequestId) return;
    button.disabled = false;
    button.textContent = "Try location again";
    showToast(locationErrorMessage(error));
  }, { enableHighAccuracy: true, timeout: 15000, maximumAge: 60000 });
}
function clearLocation() {
  state.locationRequestId += 1;
  state.location = null;
  state.osmProviders = [];
  state.osmSearchError = "";
  state.nearbyClinics = [];
  renderAppointmentSuggestions();
  if (state.map) {
    state.map.remove();
    state.map = null;
    state.markers = null;
  }
  $("#clinic-map").hidden = true;
  $("#nearby-controls").hidden = true;
  $("#nearby-content").innerHTML = '<p class="empty">Sign in, then choose “Find doctors near me” to search nearby providers.</p>';
  $("#pharmacy-nearby-results").innerHTML = '<p class="empty">Sign in and choose “Find stores near me” to search nearby pharmacies.</p>';
  $("#route-status").textContent = "";
  $("#locate-button").disabled = false;
  $("#locate-button").textContent = "Find doctors near me";
}
(async function init() {
  try {
    [state.departments, state.doctors, state.products, state.clinics] = await Promise.all([
      api("departments"), api("doctors"), api("products"), api("clinics")
    ]);
    renderDepartments();
    renderDoctors();
    renderProducts();
    saveCart();
    const session = await api("me");
    await saveUser(session.user);
  } catch (error) {
    showToast(error.message);
  }
})();
