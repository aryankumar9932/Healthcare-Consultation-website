(function () {
  const en = {
    "nav.dashboard":"Dashboard", "nav.doctors":"Doctors", "nav.hospitals":"Hospitals", "nav.nearby":"Nearby care", "nav.ai":"AI tools", "nav.ml":"ML service", "nav.pharmacy":"Pharmacy", "nav.appointments":"My appointments", "nav.doctorDash":"Doctor dashboard",
    "header.password":"Password", "header.signin":"Sign in", "header.signout":"Sign out", "header.cart":"Cart", "header.hi":"Hi, {name}",
    "hero.eyebrow":"YOUR HEALTH, OUR PRIORITY", "hero.title":"Healthcare that puts <em>you</em> first.", "hero.text":"Find trusted doctors, book appointments, and order your essential medicines in one simple place.", "hero.find":"Find a doctor", "hero.pharmacy":"Visit pharmacy",
    "trust.verified":"✓ Verified specialists", "trust.secure":"✓ Secure & private", "trust.easy":"✓ Easy booking",
    "booking.title":"Book an appointment", "booking.datetime":"Date and time", "booking.day":"Pick a day", "booking.symptoms":"Symptoms or reason for visit", "booking.symptomsHint":"(optional; shared with your assigned doctor)", "booking.notes":"Anything else we should know?", "booking.optional":"(optional)", "booking.confirm":"Confirm appointment",
    "orders.eyebrow":"YOUR MEDICINES", "orders.title":"My orders", "admin.orders.title":"Manage medicine orders", "orders.empty":"No orders yet.", "orders.total":"Total", "orders.cancel":"Cancel order", "orders.cancelConfirm":"Cancel this order? Only orders still processing can be cancelled.", "orders.history":"Order history", "orders.all":"All", "orders.note":"Note or tracking number", "orders.progress":"Order progress", "orders.cancelled":"Cancelled", "orders.mark":"Mark {status}",
    "status.Pending":"Pending", "status.Accepted":"Accepted", "status.Rejected":"Rejected", "status.Completed":"Completed", "status.Cancelled":"Cancelled", "status.No-show":"No-show", "status.Processing":"Processing", "status.Packed":"Packed", "status.Shipped":"Shipped", "status.Delivered":"Delivered", "status.Request saved · unconfirmed":"Saved request · unconfirmed",
    "refund.done":"Appointment cancelled. A refund of {amount} {currency} has been started (5–7 working days).", "refund.failed":"Appointment cancelled. We could not start your refund automatically; our team will complete it.", "refund.label":"Refunded", "cancel.done":"Appointment cancelled.", "cancel.confirm":"Cancel this appointment? Paid visits are refunded in full 24+ hours before, otherwise 50%."
  };
  const hi = {
    "nav.dashboard":"डैशबोर्ड", "nav.doctors":"डॉक्टर", "nav.hospitals":"अस्पताल", "nav.nearby":"आस-पास की देखभाल", "nav.ai":"AI टूल", "nav.ml":"ML सेवा", "nav.pharmacy":"फ़ार्मेसी", "nav.appointments":"मेरी अपॉइंटमेंट", "nav.doctorDash":"डॉक्टर डैशबोर्ड",
    "header.password":"पासवर्ड", "header.signin":"साइन इन", "header.signout":"साइन आउट", "header.cart":"कार्ट", "header.hi":"नमस्ते, {name}",
    "hero.eyebrow":"आपका स्वास्थ्य, हमारी प्राथमिकता", "hero.title":"स्वास्थ्य सेवा में <em>आप</em> सबसे पहले हैं।", "hero.text":"विश्वसनीय डॉक्टर खोजें, अपॉइंटमेंट बुक करें और ज़रूरी दवाएँ एक ही जगह मँगाएँ।", "hero.find":"डॉक्टर खोजें", "hero.pharmacy":"फ़ार्मेसी देखें",
    "trust.verified":"✓ सत्यापित विशेषज्ञ", "trust.secure":"✓ सुरक्षित और निजी", "trust.easy":"✓ आसान बुकिंग",
    "booking.title":"अपॉइंटमेंट बुक करें", "booking.datetime":"तारीख़ और समय", "booking.day":"दिन चुनें", "booking.symptoms":"लक्षण या मिलने का कारण", "booking.symptomsHint":"(वैकल्पिक; आपके डॉक्टर के साथ साझा होगा)", "booking.notes":"क्या आप कुछ और बताना चाहेंगे?", "booking.optional":"(वैकल्पिक)", "booking.confirm":"अपॉइंटमेंट पक्का करें",
    "orders.eyebrow":"आपकी दवाएँ", "orders.title":"मेरे ऑर्डर", "admin.orders.title":"दवा ऑर्डर प्रबंधित करें", "orders.empty":"अभी कोई ऑर्डर नहीं है।", "orders.total":"कुल", "orders.cancel":"ऑर्डर रद्द करें", "orders.cancelConfirm":"क्या यह ऑर्डर रद्द करें? केवल प्रक्रिया में चल रहे ऑर्डर रद्द किए जा सकते हैं।", "orders.history":"ऑर्डर इतिहास", "orders.all":"सभी", "orders.note":"नोट या ट्रैकिंग नंबर", "orders.progress":"ऑर्डर की प्रगति", "orders.cancelled":"रद्द", "orders.mark":"{status} करें",
    "status.Pending":"लंबित", "status.Accepted":"स्वीकृत", "status.Rejected":"अस्वीकृत", "status.Completed":"पूरा हुआ", "status.Cancelled":"रद्द", "status.No-show":"नहीं आए", "status.Processing":"प्रक्रिया में", "status.Packed":"पैक किया गया", "status.Shipped":"भेज दिया गया", "status.Delivered":"पहुँचा दिया गया", "status.Request saved · unconfirmed":"अनिश्चित अनुरोध सहेजा गया",
    "refund.done":"अपॉइंटमेंट रद्द। {amount} {currency} का रिफंड शुरू हो गया है (5–7 कार्यदिवस)।", "refund.failed":"अपॉइंटमेंट रद्द। रिफंड अपने-आप शुरू नहीं हो सका; हमारी टीम इसे पूरा करेगी।", "refund.label":"रिफंड किया गया", "cancel.done":"अपॉइंटमेंट रद्द कर दी गई।", "cancel.confirm":"अपॉइंटमेंट रद्द करें? 24 घंटे से पहले पूरा रिफंड, अन्यथा 50% रिफंड मिलेगा।"
  };
  let lang = "en";
  try { const saved = localStorage.getItem("careconnect-lang"); lang = saved === "hi" || saved === "en" ? saved : (navigator.language || "").toLowerCase().startsWith("hi") ? "hi" : "en"; } catch {}
  const t = (key, vars) => { let value = (lang === "hi" && hi[key]) || en[key] || key; for (const [name, item] of Object.entries(vars || {})) value = value.replaceAll(`{${name}}`, String(item)); return value; };
  const tStatus = status => t(`status.${status}`) === `status.${status}` ? status : t(`status.${status}`);
  function apply(root = document) {
    document.documentElement.lang = lang;
    root.querySelectorAll("[data-i18n]").forEach(el => { el.textContent = t(el.dataset.i18n); });
    root.querySelectorAll("[data-i18n-html]").forEach(el => { el.innerHTML = t(el.dataset.i18nHtml); });
    root.querySelectorAll("[data-i18n-placeholder]").forEach(el => { el.placeholder = t(el.dataset.i18nPlaceholder); });
    const select = document.getElementById("lang-select"); if (select) select.value = lang;
  }
  function setLang(next) { if (next !== "en" && next !== "hi") return; lang = next; try { localStorage.setItem("careconnect-lang", lang); } catch {} apply(); document.dispatchEvent(new CustomEvent("languagechange", { detail: { lang } })); }
  window.i18n = { t, tStatus, apply, setLang, get lang() { return lang; } };
  const start = () => { apply(); document.getElementById("lang-select")?.addEventListener("change", event => setLang(event.target.value)); };
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start); else start();
})();
