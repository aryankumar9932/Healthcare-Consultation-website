# Healthcare Consultation Platform

This project runs as a full-stack Node.js and Express website, served from `server.js` and `public/`. Accounts, appointments, orders, and the existing catalogue are stored in `data/db.json`.

## Run the website

Requirements: Node.js 18 or newer and npm.

```powershell
npm install
npm start
```

Open `http://localhost:3000`. Set a different port in PowerShell with `$env:PORT=3001; npm start`.

Dashboard, Doctors, Hospitals, Nearby care, AI tools, ML service, Pharmacy, My appointments, and Doctor Dashboard each have their own URL and page view. Open them directly at `/dashboard`, `/doctors`, `/hospitals`, `/nearby`, `/ai-tools`, `/ml-service`, `/pharmacy`, `/appointments`, and `/doctor`.

## Nearby doctors and map routes

After signing in, the site offers an explicit location-sharing confirmation. If accepted, approve the browser location prompt to search OpenStreetMap for nearby doctors, clinics, dentists, hospitals, and pharmacies/medical stores. The Doctors page lists named doctor/dentist map listings, while Hospitals lists mapped hospitals separately; community data may be incomplete, and a doctor's listing name can be a practice rather than an individual clinician. Both pages and Nearby care show interactive Leaflet maps with OpenStreetMap tiles and contributor attribution. If browser GPS is inaccurate, use the place search (pre-filled with Moradabad) to choose a town or address instead. The selected coordinates are kept only in the current browser tab's session storage so they can be reused when switching app pages; use “Forget saved location” to clear them. The searched place name is sent to OpenStreetMap's public Nominatim service, and nearby coordinates are sent to the CareConnect server and Overpass API when searching; CareConnect does not save this location. Use the Type filter to show medical stores only, healthcare only, or both. Pharmacy lookup includes the OpenStreetMap `amenity=pharmacy`, `healthcare=pharmacy`, and `shop=chemist` tags and uses a separate result limit so healthcare listings do not crowd out pharmacies. Listings are community-maintained and may be incomplete or outdated. When nearby OSM results are empty, optional links open Google Maps searches for local hospitals/doctors or pharmacies; those links do not fetch Google data into CareConnect and send the selected location to Google when opened. Fetching Google Places results inside CareConnect requires your own Google Maps Platform API key and billing-enabled project. Coordinates are sent to the CareConnect server and Overpass API for the search and are not saved by CareConnect. Driving directions open OpenStreetMap's public directions service. Public OpenStreetMap services have usage limits and are subject to their attribution requirements, usage policies, and availability. Location search requires localhost or HTTPS.

The Appointments section also displays nearby healthcare listings sorted by distance and lets patients choose a search radius. Bookable CareConnect doctors open the existing appointment form. Patients may save a requested date and time for an external OpenStreetMap healthcare listing; this request is only stored in their CareConnect appointment list and is not sent to or confirmed by the provider. Contact the listed provider directly to arrange and confirm the visit. Location is requested only after the patient chooses to share it.

The map uses Leaflet and OpenStreetMap tiles, with visible contributor attribution. Nearby businesses are queried from the public Overpass API. Please avoid repeated automated searches; public Overpass and tile services are not guaranteed for high-volume or commercial use.

The Pharmacy section can search the same location-based OpenStreetMap results for nearby medical stores. Store details, distance, mapped opening hours, and addresses are community-maintained, may be missing or outdated, and do not provide live stock or verified prices. Public Overpass data is not a real-time inventory or pharmacy-price service.

No clinic locations are seeded or fabricated. A directory administrator can add, edit, and remove clinic locations from the in-page management section. Register the intended administrator account first. Set `ADMIN_EMAIL` to its email and `ADMIN_SETUP_TOKEN` to a private random secret of at least 32 characters, then restart the server and sign in to that account. Enter the secret into the one-time administrator activation form. After activation, unset `ADMIN_SETUP_TOKEN` and restart; the administrator role is saved on the account. For example, in PowerShell:

```powershell
$env:ADMIN_EMAIL="admin@example.com"
$env:ADMIN_SETUP_TOKEN="replace-with-a-private-random-secret-at-least-32-characters"
npm start
```

The administrator enters the real clinic address; it is sent to Nominatim's public OpenStreetMap address search to place the clinic marker. Newly added or relocated clinics stay out of patient search until the administrator previews the pin on OpenStreetMap and confirms publication. The associated clinic and doctor must be in the existing catalogue. Nominatim is a public service subject to its usage policy; do not use it for bulk geocoding.

## Doctor dashboard and care navigation

The symptom tool is a navigation aid that suggests a specialist from patient-entered symptoms. It does not diagnose conditions, triage emergencies, or prescribe treatment. It links to the nearby doctor directory; recommendations and urgency suggestions can be wrong. Do not rely on the demo model for medical decisions or emergencies.

Doctor access is not public self-registration. First bootstrap an administrator as described above. From the Dashboard, use “Create doctor account” to link a sign-in account to an unassigned doctor directory profile. Use a unique email and initial password of at least 12 characters, then deliver that password to the clinician privately. The new account is also emailed an address-confirmation link. Doctors can change their password from the **Password** button and use **Forgot your password?** on the sign-in dialog to reset it by email (see "Email, confirmation and password reset" below), so the temporary password does not have to be permanent. The doctor signs in through the regular sign-in dialog and opens `/doctor`. The dashboard is restricted to appointments assigned to that linked profile and supports request acceptance/rejection, symptom review, access to reports for patients with an appointment assigned to that doctor, consultation notes, prescriptions, completion, and availability. Patients see their appointment history, uploaded reports, measurements explicitly labeled in reports, issued prescriptions, and appointment-count analytics. Optional birth date is used only for broad age buckets in the administrator's aggregate analytics.

Appointment statuses follow `Pending → Accepted/Rejected → Completed`; only the assigned doctor can make these transitions. The doctor can save notes and issue or update a prescription for an accepted/completed appointment. Patients can download a generated PDF from their appointment page. Prescription medicine names, dosage, duration, and instructions are entered by the doctor; CareConnect does not recommend a medicine or verify that a prescription is clinically appropriate.

### Reports, encryption, and limits

Patients can upload one PDF, DOCX, TXT, PNG, JPG, or WEBP report (up to 8 MB). Text is extracted locally from text-based PDFs, DOCX, and TXT. Scanned PDF OCR is not implemented. Image extraction sends the image to Gemini only after the patient explicitly checks the consent box and requires `GEMINI_API_KEY`. Extracted text is scanned for a small set of explicitly labeled values (hemoglobin, WBC, blood pressure, weight, and glucose) and explicit condition/medicine headings; it does not interpret ranges, make diagnoses, or infer missing values. Extraction can miss or misread information: always compare it with the original and have a clinician verify it.

Uploaded report bytes, extracted report payloads, and prescription payloads are encrypted with AES-256-GCM before database storage; report filenames, MIME types, timestamps, and patient links remain plaintext metadata. Set a stable, private `REPORT_ENCRYPTION_KEY` in `.env` (for example, generate one with `openssl rand -hex 32`) and keep it backed up separately from the database. If unset, the app derives the encryption key from `SESSION_SECRET`; changing either key makes already stored clinical payloads unreadable. Key rotation/re-encryption tooling is not included. Appointment symptoms and notes remain ordinary database fields, so protect the database, backups, logs, and host; this demo is not a certified clinical-record system.

### Video consultation

Only participants in an accepted CareConnect appointment can exchange WebRTC offer/answer and ICE signaling. Audio/video is sent peer-to-peer through WebRTC's encrypted media transport; CareConnect does not record or store call media. The signaling queue is held in process memory for up to 15 minutes, so calls require both users to reach the same running app instance and cannot resume after a restart. A public STUN server is used for this demo; real deployments need a properly secured TURN service and shared signaling infrastructure for multi-instance operation. Camera/microphone access requires localhost or HTTPS. No call recording, waiting room, identity verification, or emergency service is provided.

## Enable online AI tools

The document reader and AI health chat use Google's Gemini API. The specialty guide and experimental appointment attendance estimate can use the optional local ML service below; when the specialty model is uncertain or the service is unavailable, specialty recommendations fall back to Gemini. Create an API key in [Google AI Studio](https://aistudio.google.com/app/apikey), then set it in the PowerShell session used to start CareConnect:

```powershell
$env:GEMINI_API_KEY="your-private-api-key"
npm start
```

The default model is `gemini-3.5-flash`. To select another Gemini API model, set `GEMINI_MODEL` before starting the server. Never put the API key in browser code or commit it to the repository. Usage limits, availability, and pricing depend on Google's current terms and the selected model; check Google AI Studio before use. AI requests return an explicit configuration or service error if the key, quota, or service is unavailable.

Prompts, symptoms, extracted document text, and uploaded document images are sent from the CareConnect server to Google's Gemini API for processing. Uploads are held in memory and are not written to disk by CareConnect, but they leave the local server; review Google's current privacy and data-use terms and do not submit information you are not comfortable sharing. Google's processing and retention are governed by its terms, not CareConnect.

The sign-in-only AI health chat accepts text and one PDF, DOCX, TXT, PNG, JPG, JPEG, or WEBP attachment per message (up to 8 MB; extracted document text is limited to 12,000 characters). It can explain general health information and help interpret readable document text, including scanned PDFs where the configured Gemini model supports PDF input. Chat history stays in the browser session and is sent to Gemini as context; CareConnect does not save the chat. The chat can offer a cautious suggestion about when to contact care, but it is not a diagnosis or a reliable triage service. It does not recommend medicines or create a personalized dose or medication schedule. Confirm medicine instructions with a pharmacist or prescriber; for an emergency, contact local emergency services immediately.

The document reader accepts pasted text or a PDF, DOCX, TXT, PNG, JPG, JPEG, or WEBP upload (up to 8 MB). Choose prescription reading to extract only the medicines, strengths, and explicitly stated quantities, then compare exact product matches with the current catalogue price. The starter catalogue currently contains only two sample products; add real, verified products and rates to the catalogue before relying on its prices. Totals are estimated from the catalogue rate and stated quantity; unmatched items are not priced, and catalogue entries do not confirm stock. This feature reads prescriptions and does not recommend medicines, calculate missing quantities, or substitute products. A pharmacist should verify the prescription and quantity.

The document endpoint accepts PDF, DOCX, TXT, PNG, JPG, and WEBP files up to 8 MB. Images are submitted directly to Gemini, so image reading requires a model that supports image input. There is no substitute or heuristic AI response.

AI output is informational and may be incorrect. Specialty suggestions are not diagnoses; attendance estimates are experimental and not validated; document summaries should be checked with a healthcare professional. AI output must not determine access to care. For urgent or emergency symptoms, contact a qualified clinician or local emergency services.

## Optional local ML service

The optional FastAPI service provides a TF-IDF/logistic-regression specialty suggestion with a separate emergency-keyword warning, plus an experimental appointment no-show estimate. Both models are trained from synthetic demonstration data only. The reported metrics are measurements on synthetic holdout data, not evidence of real-world accuracy, clinical safety, or calibration. Have clinicians review the symptom rules and retrain and validate using appropriately consented, de-identified data before any real-world use. Never use the no-show estimate to deny, delay, penalize, or overbook care; at most, it may inform an additional reminder.

For local development, use Python 3.12, train the models, and start the service in a second PowerShell window:

```powershell
cd ml-service
python -m pip install -r requirements.txt
python train.py
$env:ML_SERVICE_KEY="replace-with-a-private-random-service-key"
python -m uvicorn app:app --host 127.0.0.1 --port 8000
```

Start the Node app in another window with the same key:

```powershell
$env:ML_SERVICE_URL="http://127.0.0.1:8000"
$env:ML_SERVICE_KEY="replace-with-a-private-random-service-key"
npm start
```

If the local service is not configured or is unavailable, the app falls back to Gemini for specialty recommendations and attendance estimates. The service requires `ML_SERVICE_KEY`; keep it private. It accepts symptom text for specialty suggestions, and appointment timing, fee, and coarse attendance-history features for no-show estimates. Because CareConnect does not collect age or reminder-delivery history, those two model inputs use fixed demo defaults. Do not expose the ML service directly to the public internet.

To run the container stack, set long random `SESSION_SECRET` and `ML_SERVICE_KEY` values, then run `docker compose up --build`. Gemini remains optional, but its tools require `GEMINI_API_KEY`.

See [REVIEW_AND_ROADMAP.md](./REVIEW_AND_ROADMAP.md) for limitations and recommended production work.

## Production configuration

Set `NODE_ENV=production` and provide a long, random `SESSION_SECRET` before launch. The session cookie is HTTP-only, SameSite=Lax, and marked Secure in production. Set `DATABASE_URL` in production: PostgreSQL stores the data and the sessions (see "Database (PostgreSQL)" below). Without it the app falls back to an in-memory session store and the JSON file, which are for local development and small demonstrations only. Serve the site over HTTPS and back up the database.

Run the available unit tests with `npm test`.

## Database (PostgreSQL)

By default the app stores data in `data/db.json` (development/demo only). Set `DATABASE_URL` to use PostgreSQL; migrations in `db/migrations/` run automatically at start-up (or run `npm run migrate`), the starter catalogue is seeded once, and sessions are stored in the database so they survive restarts and work across several app instances.

```bash
docker compose up --build        # web + PostgreSQL + ML service (see .env.example for required secrets)
# or locally:
DATABASE_URL=postgres://user:pass@localhost:5432/careconnect npm start
```

Moving existing JSON data (keeps ids and password hashes): `DATABASE_URL=... npm run import:json -- data/db.json --force` (the `--force` flag wipes the target tables first).
Run the full test suite against PostgreSQL with `DATABASE_URL=... npm run test:pg` (this **truncates** the user, appointment, order and clinic tables, so use a throw-away database).

## Email, confirmation and password reset

- **Confirmation:** every new account is emailed a one-time link (valid 24 hours). Until it is used, the account can sign in and browse but cannot book appointments, order medicines or upload reports (`403 EMAIL_NOT_VERIFIED`); a banner with a **Resend email** button explains this. Resending is limited to one email per minute and revokes the previous link.
- **Forgot password:** the sign-in dialog has **Forgot your password?**. The reply is the same whether or not the account exists. The emailed link is valid for 1 hour and works once; a newer link revokes older ones. Using it sets the new password, confirms the email address, clears any sign-in lockout and **signs the account out on every device**; a "password changed" notice is emailed. A too-short password does not use up the link.
- **Change password:** the **Password** button (signed-in users) needs the current password, signs out other devices, and shares the sign-in lockout so a stolen session cannot guess the current password.
- **Token safety:** only a SHA-256 hash of each token is stored; links are built from `APP_URL`, never from the request's `Host` header (so a forged header cannot poison them); the token is removed from the address bar as soon as the page loads, and the link pages are sent with `Cache-Control: no-store` and `Referrer-Policy: no-referrer`.
- **Configure email:** set `SMTP_URL` (for example `smtps://user:password@smtp.example.com:465`) or `SMTP_HOST`/`SMTP_PORT`/`SMTP_USER`/`SMTP_PASS`, plus `MAIL_FROM` and `APP_URL` (required in production, used for the links). Without SMTP, development mode (`NODE_ENV` not `production`) prints each email, including its link, to the server console; in production nothing is sent and, with a warning at start-up, confirmation is **not** enforced so nobody is locked out. `REQUIRE_VERIFIED_EMAIL=true|false` overrides that. Never put real credentials in the repository; use a provider such as Brevo, SendGrid, Amazon SES or a Gmail app password.
- **Limits:** password endpoints 10 per 15 minutes and email endpoints 30 per hour per IP (`RATE_LIMIT_RESET`, `RATE_LIMIT_EMAIL`).

Not covered: changing the account email address, MFA, and delivery tracking (bounces).

## Security controls

- **Headers / CSP:** `helmet` with a strict Content-Security-Policy (no inline scripts or styles), HSTS in production, `frame-ancestors 'none'`, Permissions-Policy. Leaflet assets are loaded with Subresource Integrity.
- **CSRF:** every state-changing `/api` request needs the `X-CSRF-Token` header (get it from `GET /api/csrf`); the bundled frontend does this automatically. Cookies are also `HttpOnly` + `SameSite=Lax` (+ `Secure` in production).
- **Rate limiting:** per client IP: 600 API requests / 15 min, 20 sign-in or register attempts / 15 min, 60 AI requests / hour (override with `RATE_LIMIT_*`). Limits are in memory per instance; use a shared store (e.g. Redis) when running several instances. Set `TRUST_PROXY=1` behind a reverse proxy so the real client IP is used.
- **Account lockout:** 5 failed sign-ins lock an account for 15 minutes (`LOGIN_MAX_FAILURES`, `LOGIN_LOCK_MINUTES`); unknown emails are counted identically so the lock does not reveal which accounts exist. Failed sign-ins on unknown accounts take the same time as real ones.
- **Sessions:** the session id is replaced on sign-in and registration (session fixation protection).

Not yet covered: MFA, changing the account email address, audit logging, general field-level encryption of appointment data (appointment symptoms and notes remain plaintext), clinical-key rotation, and a shared rate-limit store.
