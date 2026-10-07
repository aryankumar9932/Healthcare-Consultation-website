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

## Nearby doctors and map routes

After signing in, the site offers an explicit location-sharing confirmation. If accepted, approve the browser location prompt to search OpenStreetMap for nearby doctors, clinics, dentists, hospitals, and pharmacies/medical stores. Use the Type filter to show medical stores only, healthcare only, or both. Pharmacy lookup includes the OpenStreetMap `amenity=pharmacy`, `healthcare=pharmacy`, and `shop=chemist` tags and uses a separate result limit so healthcare listings do not crowd out pharmacies. Listings are community-maintained and may be incomplete or outdated. When nearby OSM results are empty, optional links open Google Maps searches for local hospitals/doctors or pharmacies; those links do not fetch Google data into CareConnect and send the selected location to Google when opened. Fetching Google Places results inside CareConnect requires your own Google Maps Platform API key and billing-enabled project. Coordinates are sent to the CareConnect server and Overpass API for the search and are not saved by CareConnect. Map tiles use OpenStreetMap; driving directions open OpenStreetMap's public directions service. This uses public services without a Google Maps API key and is subject to their attribution requirements, usage policies, availability, and rate limits. Location search requires localhost or HTTPS.

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

Set `NODE_ENV=production` and provide a long, random `SESSION_SECRET` before launch. The session cookie is HTTP-only, SameSite=Lax, and marked Secure in production. The default Express session store is in-memory and intended for local development only; configure a persistent production session store, HTTPS, and persistent storage/backup for the JSON database before deployment. The included JSON store is intended for a small demonstration, not concurrent or regulated production workloads.

The legacy PHP payment endpoints require `SSLCOMMERZ_STORE_ID` and `SSLCOMMERZ_STORE_PASSWORD` in the PHP process environment. No payment credentials are included in the repository.

Run the available unit tests with `npm test`.
