# Healthcare Consultation Platform

This project runs as a full-stack Node.js and Express website. The original PHP pages remain in the repository, while the runnable application is served from `server.js` and `public/`. Accounts, appointments, orders, and the existing catalogue are stored in `data/db.json`.

The legacy `SQL/online_rest.sql` file contains table definitions only. Its original demo records were removed before public publishing because they included personal details and weak password hashes.

## Run the website

Requirements: Node.js 18 or newer and npm.

```powershell
npm install
npm start
```

Open `http://localhost:3000`. Set a different port in PowerShell with `$env:PORT=3001; npm start`.

Dashboard, Doctors, Hospitals, Nearby care, AI tools, ML service, Pharmacy, and My appointments each have their own URL and page view. Open them directly at `/dashboard`, `/doctors`, `/hospitals`, `/nearby`, `/ai-tools`, `/ml-service`, `/pharmacy`, and `/appointments`.

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

The legacy PHP payment endpoints require `SSLCOMMERZ_STORE_ID` and `SSLCOMMERZ_STORE_PASSWORD` in the PHP process environment. No payment credentials are included in the repository.

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

## Security controls

- **Headers / CSP:** `helmet` with a strict Content-Security-Policy (no inline scripts or styles), HSTS in production, `frame-ancestors 'none'`, Permissions-Policy. Leaflet assets are loaded with Subresource Integrity.
- **CSRF:** every state-changing `/api` request needs the `X-CSRF-Token` header (get it from `GET /api/csrf`); the bundled frontend does this automatically. Cookies are also `HttpOnly` + `SameSite=Lax` (+ `Secure` in production).
- **Rate limiting:** per client IP: 600 API requests / 15 min, 20 sign-in or register attempts / 15 min, 60 AI requests / hour (override with `RATE_LIMIT_*`). Limits are in memory per instance; use a shared store (e.g. Redis) when running several instances. Set `TRUST_PROXY=1` behind a reverse proxy so the real client IP is used.
- **Account lockout:** 5 failed sign-ins lock an account for 15 minutes (`LOGIN_MAX_FAILURES`, `LOGIN_LOCK_MINUTES`); unknown emails are counted identically so the lock does not reveal which accounts exist. Failed sign-ins on unknown accounts take the same time as real ones.
- **Sessions:** the session id is replaced on sign-in and registration (session fixation protection).

Not yet covered: email verification and password reset, MFA, audit logging, field-level encryption of health data, and a shared rate-limit store.
