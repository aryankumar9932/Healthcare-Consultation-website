const savedCart = (() => {
  try {
    const cart = JSON.parse(localStorage.getItem("careconnect-cart") || "[]");
    return Array.isArray(cart) ? cart : [];
  } catch {
    return [];
  }
})();
const savedLocation = (() => {
  try {
    const location = JSON.parse(sessionStorage.getItem("careconnect-location") || "null");
    if (Number.isFinite(location?.latitude) && location.latitude >= -90 && location.latitude <= 90 &&
        Number.isFinite(location?.longitude) && location.longitude >= -180 && location.longitude <= 180) {
      return location;
    }
  } catch {
    sessionStorage.removeItem("careconnect-location");
  }
  return null;
})();
const state = {
  departments: [], doctors: [], products: [], clinics: [], osmProviders: [], nearbyClinics: [],
  cart: savedCart, user: null, selectedDoctor: null, selectedAppointmentProvider: null, location: savedLocation, locationLabel: sessionStorage.getItem("careconnect-location-label") || "", map: null,
  markers: null, locationRequestId: 0, osmSearchError: ""
};
const chatHistory = [];
const $ = selector => document.querySelector(selector);
const pageTitles = {
  dashboard: "Dashboard",
  doctors: "Doctors",
  hospitals: "Hospitals",
  doctor: "Doctor Dashboard",
  nearby: "Nearby care",
  "ai-tools": "AI tools",
  "ml-service": "ML service",
  pharmacy: "Pharmacy",
  appointments: "My appointments"
};
// Pages opened from an email link carry a one-time token: read it once and remove it from the address bar/history.
const emailLink = (() => {
  const path = window.location.pathname;
  if (path !== "/verify-email" && path !== "/reset-password") return null;
  const token = new URLSearchParams(window.location.search).get("token") || "";
  window.history.replaceState(null, "", "/dashboard");
  return { path, token };
})();
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
  return `/clinic-images/${directory}/${encodeURIComponent(file)}`;
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
  const metricCard = (label, value) => `<article class="health-metric"><span>${escapeHtml(label)}</span><strong>${escapeHtml(value)}</strong></article>`;
  async function loadPatientWorkspace() {
    const [analytics, reports, prescriptions] = await Promise.all([
      api("patient/analytics"), api("patient/reports"), api("patient/prescriptions")
    ]);
    $("#patient-metrics").innerHTML = [
      metricCard("Appointments", analytics.appointments),
      metricCard("Completed", analytics.completed),
      metricCard("Pending", analytics.pending),
      metricCard("Reports", analytics.reports),
      metricCard("Prescriptions", analytics.prescriptions)
    ].join("");
    $("#patient-reports").innerHTML = reports.length ? reports.map(report => `
      <article class="appointment-card"><div><strong>${escapeHtml(report.filename)}</strong>
        <p>${escapeHtml(new Date(report.createdAt).toLocaleString())}</p>
        ${report.measurements?.length ? `<ul>${report.measurements.map(item =>
          `<li>${escapeHtml(item.name)}: ${escapeHtml(item.value)} ${escapeHtml(item.unit)}</li>`).join("")}</ul>` : "<p>No common measurements were extracted. Review the original report.</p>"}
        ${report.history?.conditions?.length ? `<p><strong>Conditions explicitly listed in report:</strong> ${report.history.conditions.map(escapeHtml).join(", ")}</p>` : ""}
        ${report.history?.currentMedications?.length ? `<p><strong>Medicines explicitly listed in report:</strong> ${report.history.currentMedications.map(escapeHtml).join(", ")}</p>` : ""}
        <small>${escapeHtml(report.extractionSource || "Stored encrypted; extraction not yet available.")} · Results may be incomplete and must be verified by a clinician.</small>
        <p><a href="/api/reports/${report.id}/file" target="_blank" rel="noopener">Open original report</a></p></div></article>`).join("")
      : '<p class="empty">No medical reports uploaded yet.</p>';
    $("#patient-prescriptions").innerHTML = prescriptions.length ? prescriptions.map(prescription => `
      <article class="appointment-card"><div><strong>Prescription from ${escapeHtml(prescription.doctorName || "your doctor")}</strong>
        <p>${escapeHtml(new Date(prescription.createdAt).toLocaleString())}</p>
        <ul>${prescription.items.map(item => `<li>${escapeHtml(item.medicine)} · ${escapeHtml(item.dosage)} · ${escapeHtml(item.duration)}${item.instructions ? ` · ${escapeHtml(item.instructions)}` : ""}</li>`).join("")}</ul>
        ${prescription.instructions ? `<p>${escapeHtml(prescription.instructions)}</p>` : ""}
        <a class="button button-outline" href="/api/prescriptions/${prescription.id}/pdf">Download PDF</a></div></article>`).join("")
      : '<p class="empty">Your doctor has not issued a prescription yet.</p>';
  }
  async function loadAdminAnalytics() {
    const [analytics, doctors] = await Promise.all([api("admin/analytics"), api("admin/doctors/unassigned")]);
    $("#admin-analytics").innerHTML = [
      metricCard("Patients", analytics.totalPatients),
      metricCard("Consultations", analytics.consultations),
      metricCard("Completed", `${analytics.completionRate}%`),
      metricCard("Most requested specialty", analytics.mostRequestedSpecialty),
      ...Object.entries(analytics.ageDistribution).map(([range, count]) => metricCard(`Patient age ${range}`, count))
    ].join("") + `<div class="analytics-symptoms"><strong>Common symptom terms (patient-entered)</strong><p>${analytics.commonSymptoms.length
      ? analytics.commonSymptoms.map(item => `${escapeHtml(item.symptom)} (${item.count})`).join(" · ")
      : "Not enough data"}</p></div>`;
    $("#doctor-account-form [name=doctorId]").innerHTML = doctors.length
      ? doctors.map(doctor => `<option value="${doctor.id}">${escapeHtml(doctor.name)} · ${escapeHtml(doctor.specialty)}</option>`).join("")
      : '<option value="">All directory doctors already have accounts</option>';
  }
  async function loadDoctorDashboard() {
    if (currentPage !== "doctor" || state.user?.role !== "doctor") {
      if (currentPage === "doctor") $("#doctor-appointments").innerHTML =
        '<p class="empty">Sign in with an administrator-provisioned doctor account to access this workspace.</p>';
      return;
    }
    try {
      const [profile, appointments, analytics] = await Promise.all([
        api("doctor/me"), api("doctor/appointments"), api("doctor/analytics")
      ]);
      $("#doctor-profile").textContent = `${profile.doctor.name} · ${profile.doctor.specialty}`;
      $("#doctor-availability").value = (profile.doctor.schedule || []).join("\n");
      $("#doctor-metrics").innerHTML = [
        metricCard("Today's appointments", appointments.filter(item => new Date(item.date).toDateString() === new Date().toDateString()).length),
        metricCard("Pending requests", analytics.pending),
        metricCard("Total appointments", analytics.total),
        metricCard("Completed", analytics.completed)
      ].join("");
      $("#doctor-appointments").innerHTML = appointments.length ? appointments.map(appointment => `
        <article class="doctor-appointment-card"><div class="doctor-appointment-heading"><div><span class="doctor-meta">${escapeHtml(new Date(appointment.date).toLocaleString())} · ${escapeHtml(appointment.status)}</span>
          <h3>${escapeHtml(appointment.patient?.name || "Patient")}</h3><p>${escapeHtml(appointment.patient?.email || "")}${appointment.patient?.phone ? ` · ${escapeHtml(appointment.patient.phone)}` : ""}</p>
          <p><strong>Patient symptoms / reason:</strong> ${escapeHtml(appointment.symptoms || "Not provided")}</p>
          ${appointment.notes ? `<p><strong>Patient note:</strong> ${escapeHtml(appointment.notes)}</p>` : ""}
          ${appointment.reports?.length ? `<div><strong>Uploaded reports:</strong> ${appointment.reports.map(report =>
            `<a href="/api/reports/${report.id}/file" target="_blank" rel="noopener">${escapeHtml(report.filename)}</a>`).join(" · ")}</div>` : "<p>No patient reports uploaded.</p>"}
          ${appointment.prescriptionAvailable ? "<p>Prescription issued for this visit.</p>" : ""}
        </div><div class="doctor-appointment-actions">
          ${appointment.status === "Pending" ? `<button class="button button-primary" data-appointment-status="${appointment.id}" data-status="Accepted">Accept</button>
            <button class="button button-outline" data-appointment-status="${appointment.id}" data-status="Rejected">Reject</button>` : ""}
          ${appointment.status === "Accepted" ? `<button class="button button-primary" data-video-appointment="${appointment.id}">Start video consultation</button>
            <button class="button button-outline" data-appointment-status="${appointment.id}" data-status="Completed">Mark completed</button>` : ""}
        </div>
        ${["Accepted", "Completed"].includes(appointment.status) ? `
          <form class="clinical-entry-form" data-consultation="${appointment.id}"><label>Consultation notes<textarea name="notes" rows="3" maxlength="12000" required>${escapeHtml(appointment.consultationNotes || "")}</textarea></label><button class="button button-outline" type="submit">Save consultation notes</button></form>
          <form class="clinical-entry-form" data-prescription="${appointment.id}"><strong>Prescription</strong>
            <label>Medicine | dosage | duration | instructions<textarea name="items" rows="3" placeholder="Medicine name | 1 tablet | 5 days | After food" required></textarea></label>
            <label>Additional instructions<textarea name="instructions" rows="2" maxlength="4000"></textarea></label>
            <button class="button button-primary" type="submit">Issue or update prescription</button></form>` : ""}
        </article>`).join("") : '<p class="empty">No appointments have been assigned to this doctor yet.</p>';
      $("#doctor-appointments").querySelectorAll("[data-appointment-status]").forEach(button => {
        button.addEventListener("click", async () => {
          button.disabled = true;
          try {
            await api(`doctor/appointments/${button.dataset.appointmentStatus}/status`, {
              method: "POST", body: JSON.stringify({ status: button.dataset.status })
            });
            await loadDoctorDashboard();
          } catch (error) {
            showToast(error.message);
            button.disabled = false;
          }
        });
      });
      $("#doctor-appointments").querySelectorAll("[data-consultation]").forEach(form => {
        form.addEventListener("submit", async event => {
          event.preventDefault();
          const notes = new FormData(form).get("notes");
          try {
            await api(`doctor/appointments/${form.dataset.consultation}/consultation`, {
              method: "PUT", body: JSON.stringify({ notes })
            });
            showToast("Consultation notes saved.");
          } catch (error) { showToast(error.message); }
        });
      });
      $("#doctor-appointments").querySelectorAll("[data-prescription]").forEach(form => {
        form.addEventListener("submit", async event => {
          event.preventDefault();
          const body = Object.fromEntries(new FormData(form));
          const items = String(body.items).split(/\r?\n/).filter(line => line.trim()).map(line => {
            const [medicine = "", dosage = "", duration = "", instructions = ""] = line.split("|").map(part => part.trim());
            return { medicine, dosage, duration, instructions };
          });
          try {
            await api(`doctor/appointments/${form.dataset.prescription}/prescription`, {
              method: "POST", body: JSON.stringify({ items, instructions: body.instructions })
            });
            showToast("Prescription saved for the patient.");
            await loadDoctorDashboard();
          } catch (error) { showToast(error.message); }
        });
      });
      $("#doctor-appointments").querySelectorAll("[data-video-appointment]").forEach(button => {
        button.addEventListener("click", () => startVideoCall(Number(button.dataset.videoAppointment), true));
      });
    } catch (error) {
      $("#doctor-appointments").innerHTML = `<p class="empty">${escapeHtml(error.message)}</p>`;
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
  await loadMyOrders();
  await loadAdminOrders();
  if (user?.isAdmin) await loadManagedClinics();
  else clearManagedClinics();
  if (!user) openAuth();
}
function renderHeader() {
  document.body.classList.toggle("auth-required", !state.user);
  $("#user-label").textContent = state.user ? i18n.t("header.hi", { name: state.user.name.split(" ")[0] }) : "";
  $("#auth-button").textContent = state.user ? i18n.t("header.signout") : i18n.t("header.signin");
  $("#password-button").hidden = !state.user;
  const unconfirmed = Boolean(state.user && state.user.emailVerified === false && state.user.emailVerificationRequired);
  $("#verify-banner").hidden = !unconfirmed;
  if (unconfirmed) {
    $("#verify-banner-text").textContent = `Confirm your email address (${state.user.email}) to book appointments, order medicines and upload reports. Check your inbox for our message.`;
  }
  $("#doctor-nav").hidden = state.user?.role !== "doctor";
  $("#admin-clinics").hidden = !state.user?.isAdmin;
  $("#admin-bootstrap-section").hidden = !state.user?.canBootstrapAdmin;
  i18n.apply();
  refreshNotifications();
}
async function refreshNotifications() {
  $("#bell-button").hidden = !state.user;
  if (!state.user) return;
  try {
    const { unread } = await api("notifications");
    $("#bell-count").textContent = unread > 99 ? "99+" : unread;
    $("#bell-count").hidden = unread === 0;
  } catch { /* the bell is not critical */ }
}
async function openNotifications() {
  try {
    const { items } = await api("notifications");
    $("#notification-list").innerHTML = items.length ? items.map(notification => {
      const link = typeof notification.link === "string" && notification.link.startsWith("/") && !notification.link.startsWith("//")
        ? notification.link : "/appointments";
      return `<a class="appointment-card notification-item ${notification.readAt ? "" : "notification-unread"}" href="${escapeHtml(link)}">
        <div><p>${escapeHtml(notification.message)}</p><span class="doctor-meta">${escapeHtml(new Date(notification.createdAt).toLocaleString())}</span></div></a>`;
    }).join("") : '<p class="empty">No notifications yet.</p>';
    if (!$("#notification-dialog").open) $("#notification-dialog").showModal();
  } catch (error) { showToast(error.message); }
}
$("#bell-button").addEventListener("click", openNotifications);
$("#notifications-mark-read").addEventListener("click", async () => {
  try {
    await api("notifications/read", { method: "POST", body: JSON.stringify({}) });
    await refreshNotifications();
    await openNotifications();
  } catch (error) { showToast(error.message); }
});
setInterval(() => { if (!document.hidden) refreshNotifications(); }, 60 * 1000);
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
  $("#doctor-account-form [name=doctorId]").innerHTML =
    `<option value="">Loading available profiles…</option>`;
}
function renderDoctors() {
  const grid = $("#doctor-grid");
  if (!state.location) {
    grid.innerHTML = `<div class="doctor-location-prompt"><p class="empty">Share your location to see real doctors and dentists listed near you.</p>
      <button class="button button-primary" type="button" data-find-real-doctors>Find doctors near me</button></div>`;
    grid.querySelector("[data-find-real-doctors]").addEventListener("click", findMyLocation);
    $("#doctors-map").hidden = true;
    return;
  }
  const radius = Number($("#nearby-radius").value);
  const specialty = $("#nearby-specialty").value;
  const doctors = CareConnectGeo.findNearby(
    state.osmProviders.filter(CareConnectGeo.isDoctor),
    state.location,
    radius,
    specialty
  );
  grid.innerHTML = doctors.length ? doctors.map(doctor => `
    <article class="nearby-card"><div><div class="doctor-meta">${escapeHtml(doctor.doctor.specialty)} · ${doctor.distanceKm.toFixed(1)} km away · OpenStreetMap listing</div>
      <h3>${escapeHtml(doctor.name)}</h3><p>${escapeHtml(doctor.address)}</p>
      ${doctor.phone ? `<p><a href="tel:${escapeHtml(doctor.phone.replace(/[^\d+(). -]/g, ""))}">${escapeHtml(doctor.phone)}</a></p>` : ""}
      ${doctor.mapURI ? `<a href="${escapeHtml(doctor.mapURI)}" target="_blank" rel="noopener noreferrer">View OpenStreetMap listing</a>` : ""}</div></article>`).join("")
    : '<p class="empty">No nearby doctors or dentists were found in OpenStreetMap for this distance. Try a wider radius or another specialty.</p>';
  $("#doctors-map").hidden = false;
  if (currentPage === "doctors") createMap("doctors-map", doctors);
}
function renderHospitals() {
  const grid = $("#hospital-grid");
  if (!state.location) {
    grid.innerHTML = `<div class="doctor-location-prompt"><p class="empty">Share or enter your location to find hospitals near you.</p>
      <button class="button button-primary" type="button" data-find-hospitals>Find hospitals near me</button>
      <p><a href="/nearby">Choose a town or address instead</a></p></div>`;
    grid.querySelector("[data-find-hospitals]").addEventListener("click", findMyLocation);
    $("#hospital-map").hidden = true;
    return;
  }
  const hospitals = CareConnectGeo.findNearby(
    state.osmProviders.filter(CareConnectGeo.isHospital),
    state.location,
    Number($("#nearby-radius").value)
  );
  grid.innerHTML = hospitals.length ? hospitals.map(hospital => `
    <article class="nearby-card"><div><div class="doctor-meta">Hospital · ${hospital.distanceKm.toFixed(1)} km away · OpenStreetMap listing</div>
      <h3>${escapeHtml(hospital.name)}</h3><p>${escapeHtml(hospital.address)}</p>
      ${hospital.phone ? `<p><a href="tel:${escapeHtml(hospital.phone.replace(/[^\d+(). -]/g, ""))}">${escapeHtml(hospital.phone)}</a></p>` : ""}
      ${hospital.openingHours ? `<p>Hours listed: ${escapeHtml(hospital.openingHours)}</p>` : ""}
      ${hospital.mapURI ? `<a href="${escapeHtml(hospital.mapURI)}" target="_blank" rel="noopener noreferrer">View OpenStreetMap listing</a>` : ""}</div></article>`).join("")
    : '<p class="empty">No hospitals were found in OpenStreetMap for this distance. Try a wider distance or another location.</p>';
  $("#hospital-map").hidden = false;
  if (currentPage === "hospitals") createMap("hospital-map", hospitals);
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
  if (state.user?.role === "doctor") {
    $("#appointment-list").innerHTML = '<p class="empty">Doctor accounts use the Doctor Dashboard to manage patient appointments.</p>';
    renderAppointmentSuggestions();
    await loadDoctorDashboard();
    return;
  }
  if (state.user?.role === "admin") {
    $("#appointment-list").innerHTML = '<p class="empty">Administrator accounts do not have a patient appointment list.</p>';
    return;
  }
  if (!state.user) {
    $("#appointment-list").innerHTML = '<p class="empty">Sign in to see your appointments.</p>';
    renderAppointmentSuggestions();
    $("#patient-metrics").replaceChildren();
    $("#patient-reports").replaceChildren();
    $("#patient-prescriptions").replaceChildren();
    return;
  }
  try {
    const appointments = await api("appointments");
    $("#appointment-list").innerHTML = appointments.length ? appointments.map(appointment => `
      <div class="appointment-card"><div><strong>${escapeHtml(appointment.doctor?.name || appointment.providerName || "Doctor")}</strong>
      ${appointment.providerAddress ? `<p>${escapeHtml(appointment.providerAddress)}</p>` : ""}
      <p>${escapeHtml(new Date(appointment.date).toLocaleString())}${appointment.notes ? ` · ${escapeHtml(appointment.notes)}` : ""}</p>
      ${appointment.symptoms ? `<p><strong>Reason for visit:</strong> ${escapeHtml(appointment.symptoms)}</p>` : ""}
      ${appointment.consultationNotes ? `<p><strong>Doctor's consultation notes:</strong> ${escapeHtml(appointment.consultationNotes)}</p>` : ""}
      ${appointment.providerSource === "openstreetmap" ? '<p class="appointment-unconfirmed-note">Saved in your CareConnect list only. This request was not sent to the provider; contact them directly to confirm.</p>' : ""}
      ${appointment.status === "Accepted" && appointment.doctorId ? `<button class="button button-primary" type="button" data-video-appointment="${appointment.id}">Join video consultation</button>` : ""}
      ${["Pending", "Accepted", "Request saved · unconfirmed"].includes(appointment.status) ? `<div class="appointment-actions">
        <button class="button button-outline" type="button" data-cancel-appointment="${appointment.id}">Cancel</button>
        <details><summary>Reschedule</summary><form data-reschedule="${appointment.id}"><label>New date and time<input type="datetime-local" name="date" required></label><button class="button button-outline" type="submit">Save new time</button></form></details>
      </div>` : ""}
      ${appointment.status === "Completed" && appointment.doctorId && !appointment.reviewed ? `<form class="appointment-review" data-review="${appointment.id}"><strong>Rate your visit</strong>
        <label>Rating<select name="rating" required><option value="5">★★★★★</option><option value="4">★★★★</option><option value="3">★★★</option><option value="2">★★</option><option value="1">★</option></select></label>
        <input name="comment" maxlength="1000" placeholder="Optional comment"><button class="button button-outline" type="submit">Submit review</button></form>` : ""}
      ${appointment.doctorId && ["Pending", "Accepted"].includes(appointment.status) && appointment.paymentStatus !== "paid" ? `<button class="button button-primary" type="button" data-pay-appointment="${appointment.id}">Pay consultation fee</button>` : ""}
      ${appointment.paymentStatus === "paid" ? '<span class="status">Paid</span>' : ""}
      ${appointment.refundStatus === "refunded" ? `<p>${escapeHtml(i18n.t("refund.label"))}: ${(Number(appointment.refundAmount || 0) / 100).toFixed(2)} INR</p>` : ""}
      ${appointment.refundStatus === "failed" ? `<p>${escapeHtml(i18n.t("refund.failed"))}</p>` : ""}
      </div><span class="status">${escapeHtml(i18n.tStatus(appointment.status))}</span></div>`).join("") :
      '<p class="empty">You have no appointments yet. Choose a specialist above to get started.</p>';
    renderAppointmentSuggestions();
    await loadPatientWorkspace();
    $("#appointment-list").querySelectorAll("[data-video-appointment]").forEach(button => {
      button.addEventListener("click", () => startVideoCall(Number(button.dataset.videoAppointment), false));
    });
    $("#appointment-list").querySelectorAll("[data-cancel-appointment]").forEach(button => {
      button.addEventListener("click", async () => {
        if (!confirm(i18n.t("cancel.confirm"))) return;
        button.disabled = true;
        try {
          const result = await api(`appointments/${button.dataset.cancelAppointment}/cancel`, { method: "POST" });
          if (result.refund?.status === "refunded") showToast(i18n.t("refund.done", { amount: (result.refund.amount / 100).toFixed(2), currency: result.refund.currency || "INR" }));
          else if (result.refund?.status === "failed") showToast(i18n.t("refund.failed"));
          else showToast(i18n.t("cancel.done"));
          await loadAppointments();
        }
        catch (error) { showToast(error.message); button.disabled = false; }
      });
    });
    $("#appointment-list").querySelectorAll("[data-reschedule]").forEach(form => {
      form.addEventListener("submit", async event => {
        event.preventDefault();
        try {
          await api(`appointments/${form.dataset.reschedule}/reschedule`, { method: "POST", body: JSON.stringify({ date: toIsoDate(form.elements.date.value) }) });
          showToast("Appointment rescheduled. Waiting for doctor confirmation.");
          await loadAppointments();
        } catch (error) { showToast(error.message); }
      });
    });
    $("#appointment-list").querySelectorAll("[data-review]").forEach(form => {
      form.addEventListener("submit", async event => {
        event.preventDefault();
        try {
          await api(`appointments/${form.dataset.review}/review`, { method: "POST", body: JSON.stringify({ rating: Number(form.elements.rating.value), comment: form.elements.comment.value }) });
          showToast("Thanks for your review!");
          await loadAppointments();
        } catch (error) { showToast(error.message); }
      });
    });
    $("#appointment-list").querySelectorAll("[data-pay-appointment]").forEach(button => {
      button.addEventListener("click", () => payForAppointment(Number(button.dataset.payAppointment)));
    });
  } catch (error) {
    showToast(error.message);
  }
}
const ORDER_STEPS = ["Processing", "Packed", "Shipped", "Delivered"];
const ORDER_NEXT = { Processing: ["Packed", "Cancelled"], Packed: ["Shipped", "Cancelled"], Shipped: ["Delivered"], Delivered: [], Cancelled: [] };
function renderOrder(order, admin = false) {
  const step = ORDER_STEPS.indexOf(order.status);
  const progress = step < 0 ? `<strong class="order-cancelled">${escapeHtml(i18n.tStatus(order.status))}</strong>` : `<ol class="order-steps">${ORDER_STEPS.map((status, index) => `<li class="${index <= step ? "is-done" : ""}"><span>${index + 1}</span>${escapeHtml(i18n.tStatus(status))}</li>`).join("")}</ol>`;
  const items = (order.items || []).map(item => `<li>${escapeHtml(item.name)} × ${Number(item.quantity)}</li>`).join("");
  const events = (order.events || []).map(event => `<li><strong>${escapeHtml(i18n.tStatus(event.status))}</strong>${event.note ? ` · ${escapeHtml(event.note)}` : ""}<small>${escapeHtml(new Date(event.at || event.createdAt).toLocaleString())}</small></li>`).join("");
  const actions = admin ? (ORDER_NEXT[order.status] || []).map(status => `<button class="button button-outline" data-order-status="${escapeHtml(status)}" data-order-id="${order.id}">${escapeHtml(i18n.t("orders.mark", { status: i18n.tStatus(status) }))}</button>`).join("") : order.status === "Processing" ? `<button class="button button-outline" data-cancel-order="${order.id}">${escapeHtml(i18n.t("orders.cancel"))}</button>` : "";
  return `<article class="order-card"><div class="order-card-heading"><div><h3>#${order.id} · ${escapeHtml(new Date(order.createdAt).toLocaleDateString())}</h3>${admin ? `<p>${escapeHtml(order.customer?.name || "")} · ${escapeHtml(order.customer?.email || "")}</p>` : ""}</div><strong>${escapeHtml(i18n.t("orders.total"))}: $${Number(order.total).toFixed(2)}</strong></div>${progress}<ul class="order-items">${items}</ul><details class="order-history"><summary>${escapeHtml(i18n.t("orders.history"))}</summary><ol>${events}</ol></details><div class="order-actions">${admin && actions ? `<label>${escapeHtml(i18n.t("orders.note"))}<input data-order-note="${order.id}" maxlength="200" placeholder="Tracking number or update"></label>` : ""}${actions}</div></article>`;
}
async function loadMyOrders() {
  const section = $("#my-orders");
  if (!section) return;
  section.hidden = !state.user || state.user.role === "doctor" || state.user.role === "admin";
  if (section.hidden) return;
  try {
    const orders = await api("orders");
    $("#order-list").innerHTML = orders.length ? orders.map(order => renderOrder(order)).join("") : `<p class="empty">${escapeHtml(i18n.t("orders.empty"))}</p>`;
  } catch (error) { showToast(error.message); }
}
async function loadAdminOrders() {
  const section = $("#admin-orders");
  if (!section) return;
  section.hidden = !state.user?.isAdmin;
  if (section.hidden) return;
  try {
    const status = $("#admin-order-filter").value;
    const orders = await api(`admin/orders${status ? `?status=${encodeURIComponent(status)}` : ""}`);
    $("#admin-order-list").innerHTML = orders.length ? orders.map(order => renderOrder(order, true)).join("") : `<p class="empty">${escapeHtml(i18n.t("orders.empty"))}</p>`;
  } catch (error) { showToast(error.message); }
}
$("#admin-order-filter").addEventListener("change", loadAdminOrders);
$("#admin-order-list").addEventListener("click", async event => {
  const button = event.target.closest("[data-order-status]");
  if (!button) return;
  button.disabled = true;
  try {
    const note = $(`[data-order-note="${button.dataset.orderId}"]`)?.value || "";
    await api(`admin/orders/${button.dataset.orderId}/status`, { method: "POST", body: JSON.stringify({ status: button.dataset.orderStatus, note }) });
    await loadAdminOrders();
  } catch (error) { showToast(error.message); button.disabled = false; }
});
$("#order-list").addEventListener("click", async event => {
  const button = event.target.closest("[data-cancel-order]");
  if (!button || !confirm(i18n.t("orders.cancelConfirm"))) return;
  button.disabled = true;
  try { await api(`orders/${button.dataset.cancelOrder}/cancel`, { method: "POST" }); await loadMyOrders(); }
  catch (error) { showToast(error.message); button.disabled = false; }
});
async function payForAppointment(id) {
  try {
    const order = await api(`appointments/${id}/pay/order`, { method: "POST" });
    if (!window.Razorpay) {
      await new Promise((resolve, reject) => {
        const script = document.createElement("script");
        script.src = "https://checkout.razorpay.com/v1/checkout.js";
        script.onload = resolve;
        script.onerror = () => reject(new Error("Could not load the payment window."));
        document.head.append(script);
      });
    }
    new window.Razorpay({
      key: order.keyId, amount: order.amount, currency: order.currency, order_id: order.orderId,
      name: "CareConnect", description: "Consultation fee",
      handler: async response => {
        try {
          await api(`appointments/${id}/pay/verify`, { method: "POST", body: JSON.stringify(response) });
          showToast("Payment received.");
          await loadAppointments();
        } catch (error) { showToast(error.message); }
      }
    }).open();
  } catch (error) { showToast(error.message); }
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
const toLocalInput = iso => {
  const date = new Date(iso), p = value => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${p(date.getMonth() + 1)}-${p(date.getDate())}T${p(date.getHours())}:${p(date.getMinutes())}`;
};
function setupSlotPicker(enabled) {
  const dateInput = $("#booking-form").elements.date;
  $("#booking-slots").hidden = !enabled;
  dateInput.readOnly = enabled;
  dateInput.value = "";
  $("#booking-slot-buttons").replaceChildren();
  $("#booking-day").value = "";
  $("#booking-day").min = new Date().toISOString().slice(0, 10);
}
async function loadSlots() {
  const day = $("#booking-day").value, box = $("#booking-slot-buttons");
  if (!state.selectedDoctor || !day) return;
  box.textContent = "Loading…";
  try {
    const result = await api(`doctors/${state.selectedDoctor.id}/slots?date=${encodeURIComponent(day)}`);
    box.innerHTML = result.slots.length
      ? result.slots.map(slot => `<button type="button" class="button button-outline" data-slot="${escapeHtml(slot.start)}">${escapeHtml(new Date(slot.start).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }))}</button>`).join("")
      : '<p class="empty">No free slots on this day.</p>';
  } catch (error) { box.textContent = error.message; }
}
$("#booking-day").addEventListener("change", loadSlots);
$("#booking-slot-buttons").addEventListener("click", event => {
  const button = event.target.closest("[data-slot]");
  if (!button) return;
  $("#booking-form").elements.date.value = toLocalInput(button.dataset.slot);
  $("#booking-slot-buttons").querySelectorAll("button").forEach(item => item.classList.toggle("button-primary", item === button));
});
function openBooking(id) {
  if (!state.user) return openAuth("signin", "Please sign in before booking an appointment.");
  state.selectedDoctor = state.doctors.find(doctor => doctor.id === id);
  if (!state.selectedDoctor) return showToast("That doctor is no longer available.");
  state.selectedAppointmentProvider = null;
  $("#booking-title").textContent = "Book an appointment";
  $("#booking-doctor").textContent = `${state.selectedDoctor.name} · ${state.selectedDoctor.specialty} · $${state.selectedDoctor.fee}`;
  $("#booking-request-note").hidden = true;
  $("#booking-submit").textContent = "Confirm appointment";
  setupSlotPicker(true);
  const doctorId = state.selectedDoctor.id;
  api("doctors/ratings").then(ratings => {
    const rating = ratings[doctorId];
    if (rating && state.selectedDoctor?.id === doctorId) $("#booking-doctor").textContent += ` · ★ ${rating.average} (${rating.count})`;
  }).catch(() => {});
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
  setupSlotPicker(false);
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
    <label>Email<input name="email" type="email" required></label>${isRegister ? '<label>Phone<input name="phone" maxlength="40"></label><label>Date of birth <span>(optional, for age-range health analytics)</span><input name="dateOfBirth" type="date" max="${new Date().toISOString().slice(0, 10)}"></label>' : ""}
    <label>Password<input name="password" type="password" minlength="8" maxlength="128" required></label>
    <button class="button button-primary" type="submit">${isRegister ? "Create account" : "Sign in"}</button></form>
    ${!isRegister ? '<p class="auth-help"><button type="button" class="link-button" id="forgot-link">Forgot your password?</button></p>' : ""}`;
  if (!$("#auth-dialog").open) $("#auth-dialog").showModal();
  document.querySelectorAll("[data-auth-mode]").forEach(button => button.addEventListener("click", () => openAuth(button.dataset.authMode)));
  $("#forgot-link")?.addEventListener("click", () => openForgotPassword($("#auth-form [name=email]").value));
  $("#auth-form").addEventListener("submit", async event => {
    event.preventDefault();
    const body = Object.fromEntries(new FormData(event.target));
    try {
      const result = await api(isRegister ? "register" : "login", { method: "POST", body: JSON.stringify(body) });
      await saveUser(result.user);
      $("#auth-dialog").close();
      navigateToPage(result.user.role === "doctor" ? "doctor" : "dashboard");
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
      await loadMyOrders();
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
    <p><a class="button button-primary" href="/doctors">Find nearby doctors</a></p>
    <small>Care navigation only; this is not a diagnosis or prescription. ${escapeHtml(result.disclaimer)}</small></div>`;
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
    await loadAdminAnalytics();
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
function createMap(mapId = "clinic-map", providers = state.nearbyClinics) {
  const mapElement = $(`#${mapId}`);
  if (!state.location || !mapElement) return;
  mapElement.hidden = false;
  if (!window.L) {
    mapElement.innerHTML = `<p class="empty">The interactive OpenStreetMap could not load. <a href="https://www.openstreetmap.org/?mlat=${encodeURIComponent(state.location.latitude)}&mlon=${encodeURIComponent(state.location.longitude)}#map=14/${encodeURIComponent(state.location.latitude)}/${encodeURIComponent(state.location.longitude)}" target="_blank" rel="noopener noreferrer">Open this location in OpenStreetMap</a>.</p>`;
    return;
  }
  if (state.map && state.map.getContainer() !== mapElement) {
    state.map.remove();
    state.map = null;
    state.markers = null;
  }
  if (!state.map) {
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
  providers.forEach((provider, index) => {
    const position = [provider.latitude, provider.longitude];
    locations.push(position);
    L.marker(position, { title: `${provider.name || provider.doctor.name} · ${provider.doctor.specialty}` })
      .bindPopup(`<strong>${escapeHtml(index + 1)}. ${escapeHtml(provider.name || provider.doctor.name)}</strong><br>${escapeHtml(provider.doctor.specialty)}`)
      .addTo(state.markers);
  });
  if (locations.length > 1) state.map.fitBounds(L.latLngBounds(locations).pad(0.12), { maxZoom: 14 });
  else state.map.setView(locations[0], 14);
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
  renderHospitals();
  const directory = $("#nearby-content");
  if (!providers.length) {
    directory.innerHTML = `<p class="empty">No OpenStreetMap-listed providers were returned. Try refreshing your location.</p>${googleMapsFallback("hospitals doctors clinics dentists", "hospitals and doctors")}`;
    $("#nearby-controls").hidden = true;
    createMap("clinic-map", []);
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
    createMap("clinic-map", []);
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
  createMap("clinic-map", state.nearbyClinics);
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
// ---- Email confirmation, password reset and change ----
function showAuthPanel(html) {
  $("#auth-dialog").querySelector("[data-close]").hidden = !state.user;
  $("#auth-content").innerHTML = `<div class="auth-panel"><p class="eyebrow">CARECONNECT ACCOUNT</p>${html}</div>`;
  if (!$("#auth-dialog").open) $("#auth-dialog").showModal();
}
function openForgotPassword(email = "") {
  showAuthPanel(`<h2>Reset your password</h2><p class="auth-intro">Enter your account email and we will send you a link to choose a new password.</p>
    <form id="forgot-form"><label>Email<input name="email" type="email" required value="${escapeHtml(email)}"></label>
    <button class="button button-primary" type="submit">Send reset link</button></form>
    <p class="auth-help"><button type="button" class="link-button" id="back-to-signin">Back to sign in</button></p>`);
  $("#back-to-signin").addEventListener("click", () => openAuth("signin"));
  $("#forgot-form").addEventListener("submit", async event => {
    event.preventDefault();
    const button = event.target.querySelector("button[type=submit]");
    button.disabled = true;
    try {
      const result = await api("password/forgot", { method: "POST", body: JSON.stringify(Object.fromEntries(new FormData(event.target))) });
      event.target.outerHTML = `<p class="doctor-meta" role="status">${escapeHtml(result.message)} The link is valid for 1 hour.</p>`;
    } catch (error) {
      showToast(error.message);
      button.disabled = false;
    }
  });
}
function openResetPassword(token) {
  showAuthPanel(`<h2>Choose a new password</h2><p class="auth-intro">Pick a password of at least 8 characters. You will be signed out on all devices.</p>
    <form id="reset-form"><label>New password<input name="password" type="password" minlength="8" maxlength="128" autocomplete="new-password" required></label>
    <label>Confirm new password<input name="confirm" type="password" minlength="8" maxlength="128" autocomplete="new-password" required></label>
    <button class="button button-primary" type="submit">Save new password</button></form>`);
  $("#reset-form").addEventListener("submit", async event => {
    event.preventDefault();
    const { password, confirm } = Object.fromEntries(new FormData(event.target));
    if (password !== confirm) return showToast("The two passwords do not match.");
    const button = event.target.querySelector("button[type=submit]");
    button.disabled = true;
    try {
      await api("password/reset", { method: "POST", body: JSON.stringify({ token, password }) });
      state.user = null; // the server signed this browser out too
      renderHeader();
      showAuthPanel('<h2>Password updated</h2><p class="auth-intro">Your password was changed and every device was signed out. Sign in with your new password.</p><button class="button button-primary" type="button" id="reset-done">Sign in</button>');
      $("#reset-done").addEventListener("click", () => openAuth("signin"));
    } catch (error) {
      showToast(error.message);
      button.disabled = false;
      if (/invalid or has expired/.test(error.message)) {
        event.target.outerHTML = '<p class="doctor-meta">This reset link has expired or was already used.</p><button class="button button-primary" type="button" id="request-new-link">Request a new link</button>';
        $("#request-new-link").addEventListener("click", () => openForgotPassword());
      }
    }
  });
}
function openChangePassword() {
  if (!state.user) return openAuth();
  showAuthPanel(`<h2>Change password</h2><p class="auth-intro">Other devices will be signed out after you change it.</p>
    <form id="change-form"><label>Current password<input name="currentPassword" type="password" maxlength="128" autocomplete="current-password" required></label>
    <label>New password<input name="newPassword" type="password" minlength="8" maxlength="128" autocomplete="new-password" required></label>
    <label>Confirm new password<input name="confirm" type="password" minlength="8" maxlength="128" autocomplete="new-password" required></label>
    <button class="button button-primary" type="submit">Change password</button></form>`);
  $("#change-form").addEventListener("submit", async event => {
    event.preventDefault();
    const { currentPassword, newPassword, confirm } = Object.fromEntries(new FormData(event.target));
    if (newPassword !== confirm) return showToast("The two new passwords do not match.");
    try {
      await api("password/change", { method: "POST", body: JSON.stringify({ currentPassword, newPassword }) });
      $("#auth-dialog").close();
      showToast("Password changed. Other devices were signed out.");
    } catch (error) {
      showToast(error.message);
    }
  });
}
$("#password-button").addEventListener("click", openChangePassword);
$("#resend-verification").addEventListener("click", async event => {
  event.target.disabled = true;
  try {
    const result = await api("email/verify/resend", { method: "POST" });
    showToast(result.alreadyVerified ? "Your email is already confirmed." : "Confirmation email sent. Check your inbox.");
    if (result.alreadyVerified) await refreshUser();
  } catch (error) {
    showToast(error.message);
  } finally {
    event.target.disabled = false;
  }
});
async function refreshUser() {
  const session = await api("me");
  await saveUser(session.user);
}
async function handleEmailLink() {
  if (!emailLink) return;
  if (emailLink.path === "/verify-email") {
    try {
      await api("email/verify", { method: "POST", body: JSON.stringify({ token: emailLink.token }) });
      if (state.user) await refreshUser();
      showToast("Email confirmed. Thank you!");
    } catch (error) {
      showToast(error.message);
    }
  } else if (emailLink.token) {
    openResetPassword(emailLink.token);
  } else {
    openForgotPassword();
  }
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
$("#report-upload-form").addEventListener("submit", async event => {
  event.preventDefault();
  if (!requireSignIn() || state.user.role !== undefined && state.user.role !== "patient") return;
  const form = event.currentTarget;
  const selected = $("#medical-report-file").files[0];
  if (!selected) return showToast("Choose a report file first.");
  const image = /\.(png|jpe?g|webp)$/i.test(selected.name);
  if (image && !$("#report-ai-consent").checked) {
    return showToast("Confirm that the image can be sent to Gemini for text extraction.");
  }
  setLoading(form, true, "Extracting and encrypting...");
  try {
    const report = await api("patient/reports", { method: "POST", body: new FormData(form) });
    form.reset();
    await loadPatientWorkspace();
    showToast(`Report saved encrypted. Extracted ${report.measurements.length} measurement label(s); verify them against the original.`);
  } catch (error) {
    showToast(error.message);
  } finally {
    setLoading(form, false);
  }
});
$("#doctor-account-form").addEventListener("submit", async event => {
  event.preventDefault();
  if (!state.user?.isAdmin) return showToast("Administrator access is required.");
  const form = event.currentTarget;
  setLoading(form, true, "Creating doctor account...");
  try {
    const body = Object.fromEntries(new FormData(form));
    const result = await api("admin/doctor-accounts", { method: "POST", body: JSON.stringify(body) });
    form.reset();
    showToast(`Doctor account created for ${result.doctor.name}. Give the temporary password to the clinician privately.`);
    await loadAdminAnalytics();
  } catch (error) {
    showToast(error.message);
  } finally {
    setLoading(form, false);
  }
});
$("#doctor-availability-form").addEventListener("submit", async event => {
  event.preventDefault();
  if (state.user?.role !== "doctor") return;
  const form = event.currentTarget;
  setLoading(form, true, "Saving availability...");
  try {
    const schedule = String(new FormData(form).get("schedule") || "").split(/\r?\n/).map(item => item.trim()).filter(Boolean);
    await api("doctor/availability", { method: "PUT", body: JSON.stringify({ schedule }) });
    showToast("Availability saved.");
  } catch (error) {
    showToast(error.message);
  } finally {
    setLoading(form, false);
  }
});
let activeVideoCall = null;
async function stopVideoCall() {
  const call = activeVideoCall;
  activeVideoCall = null;
  if (!call) return;
  clearInterval(call.pollTimer);
  call.stream.getTracks().forEach(track => track.stop());
  call.connection.close();
  $("#local-video").srcObject = null;
  $("#remote-video").srcObject = null;
  $("#video-dialog").close();
}
async function startVideoCall(appointmentId, doctorStarts) {
  if (!requireSignIn()) return;
  if (activeVideoCall) await stopVideoCall();
  $("#video-dialog").showModal();
  $("#video-status").textContent = "Requesting camera and microphone permission…";
  let requestedStream;
  try {
    if (!navigator.mediaDevices?.getUserMedia) {
      throw new Error("Video calls require a secure connection (localhost or HTTPS) and a camera-enabled browser.");
    }
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: true });
    requestedStream = stream;
    const connection = new RTCPeerConnection({ iceServers: [{ urls: "stun:stun.l.google.com:19302" }] });
    const call = { appointmentId, stream, connection, cursor: 0, pollTimer: null, polling: false, candidates: [] };
    activeVideoCall = call;
    $("#local-video").srcObject = stream;
    connection.addTrack(stream.getAudioTracks()[0], stream);
    connection.addTrack(stream.getVideoTracks()[0], stream);
    connection.ontrack = event => { $("#remote-video").srcObject = event.streams[0]; };
    connection.onconnectionstatechange = () => {
      $("#video-status").textContent = `Call status: ${connection.connectionState}. Media is not recorded by CareConnect.`;
    };
    connection.onicecandidate = event => {
      if (event.candidate && activeVideoCall === call) {
        api(`video/appointments/${appointmentId}/signals`, {
          method: "POST", body: JSON.stringify({ signal: { type: "candidate", candidate: event.candidate } })
        }).catch(error => showToast(error.message));
      }
    };
    const applyQueuedCandidates = async () => {
      while (call.candidates.length) await connection.addIceCandidate(call.candidates.shift());
    };
    const pollSignals = async () => {
      if (call.polling || activeVideoCall !== call) return;
      call.polling = true;
      try {
        const { signals } = await api(`video/appointments/${appointmentId}/signals?after=${call.cursor}`);
        for (const envelope of signals) {
          call.cursor = Math.max(call.cursor, envelope.id);
          const signal = envelope.signal;
          if (signal.type === "offer" && !doctorStarts) {
            await connection.setRemoteDescription(signal.description);
            await applyQueuedCandidates();
            const answer = await connection.createAnswer();
            await connection.setLocalDescription(answer);
            await api(`video/appointments/${appointmentId}/signals`, {
              method: "POST", body: JSON.stringify({ signal: { type: "answer", description: connection.localDescription } })
            });
            $("#video-status").textContent = "Connected to your doctor. This call is not recorded.";
          } else if (signal.type === "answer" && doctorStarts) {
            await connection.setRemoteDescription(signal.description);
            await applyQueuedCandidates();
            $("#video-status").textContent = "Connected to your patient. This call is not recorded.";
          } else if (signal.type === "candidate") {
            if (connection.remoteDescription) await connection.addIceCandidate(signal.candidate);
            else call.candidates.push(signal.candidate);
          }
        }
      } catch (error) {
        if (activeVideoCall === call) $("#video-status").textContent = `Connection error: ${error.message}`;
      } finally {
        call.polling = false;
      }
    };
    if (doctorStarts) {
      const offer = await connection.createOffer();
      await connection.setLocalDescription(offer);
      await api(`video/appointments/${appointmentId}/signals`, {
        method: "POST", body: JSON.stringify({ signal: { type: "offer", description: connection.localDescription } })
      });
      $("#video-status").textContent = "Calling patient… waiting for them to join.";
    } else {
      $("#video-status").textContent = "Waiting for the doctor to start the call…";
    }
    await pollSignals();
    call.pollTimer = setInterval(pollSignals, 1000);
  } catch (error) {
    await stopVideoCall();
    if (requestedStream && !activeVideoCall) requestedStream.getTracks().forEach(track => track.stop());
    $("#video-dialog").close();
    showToast(error.message);
  }
}
$("#video-end").addEventListener("click", stopVideoCall);
$("#video-dialog").addEventListener("cancel", event => { event.preventDefault(); stopVideoCall(); });
$("#video-dialog [data-video-close]").addEventListener("click", stopVideoCall);
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
    button.disabled = false;
    button.textContent = "Refresh nearby doctors";
    await searchNearbyAt(
      { latitude: position.coords.latitude, longitude: position.coords.longitude },
      "your current GPS location"
    );
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
  state.locationLabel = "";
  sessionStorage.removeItem("careconnect-location");
  sessionStorage.removeItem("careconnect-location-label");
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
  $("#clear-location-button").hidden = true;
}
async function searchNearbyAt(location, label) {
  const requestId = ++state.locationRequestId;
  state.location = location;
  state.locationLabel = label;
  sessionStorage.setItem("careconnect-location", JSON.stringify(location));
  sessionStorage.setItem("careconnect-location-label", label);
  state.osmProviders = [];
  $("#clear-location-button").hidden = false;
  $("#nearby-content").innerHTML = `<p class="empty">Searching near ${escapeHtml(label)}…</p>`;
  $("#route-status").textContent = `Search area: ${label}. This location is stored only in this browser tab and sent for nearby searches.`;
  const results = await Promise.allSettled([
    api("clinics"),
    loadOpenStreetMapProviders(location)
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
  $("#route-status").textContent = `Showing nearby results for ${label}. OpenStreetMap listings may be incomplete or outdated. Your location is not saved by CareConnect.`;
}
$("#location-search-form").addEventListener("submit", async event => {
  event.preventDefault();
  if (!requireSignIn()) return;
  const form = event.currentTarget;
  const query = String(new FormData(form).get("query") || "").trim();
  setLoading(form, true, "Searching place...");
  try {
    const result = await api("location/geocode", { method: "POST", body: JSON.stringify({ query }) });
    await searchNearbyAt({ latitude: result.latitude, longitude: result.longitude }, result.label);
  } catch (error) {
    showToast(error.message);
  } finally {
    setLoading(form, false);
  }
});
$("#clear-location-button").addEventListener("click", clearLocation);
document.addEventListener("languagechange", () => {
  renderHeader();
  renderDepartments();
  renderDoctors();
  renderHospitals();
  renderProducts();
  loadAppointments();
  loadMyOrders();
  loadAdminOrders();
});
(async function init() {
  try {
    [state.departments, state.doctors, state.products, state.clinics] = await Promise.all([
      api("departments"), api("doctors"), api("products"), api("clinics")
    ]);
    renderDepartments();
    renderDoctors();
    renderHospitals();
    renderProducts();
    saveCart();
    const session = await api("me");
    await saveUser(session.user);
    if (state.user && state.location) {
      $("#clear-location-button").hidden = false;
      await searchNearbyAt(state.location, state.locationLabel || "your saved location");
    } else renderDoctors();
    await handleEmailLink();
  } catch (error) {
    showToast(error.message);
  }
})();
