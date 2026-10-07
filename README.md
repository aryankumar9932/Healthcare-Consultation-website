# CareConnect

CareConnect is a healthcare consultation website for discovering nearby care, requesting appointments, and exploring health information. The runnable Node.js application is in [`Healthcare-Consultation-website-master/`](./Healthcare-Consultation-website-master/); the repository also contains legacy PHP pages.

## Features

- Register and sign in to a patient account.
- Search for nearby doctors, clinics, hospitals, and pharmacies using OpenStreetMap, after explicitly sharing your location.
- View nearby healthcare listings by distance and save a requested appointment date and time. Requests for external providers are **not sent to or confirmed by the provider**; contact them directly to arrange a visit.
- Book appointments with CareConnect doctors, manage bookings, and browse the sample medicine catalogue.
- Use Gemini-powered tools for general care navigation, document summaries, prescription text reading, and AI health chat with text or supported document attachments.
- Optionally run the local ML service for specialty suggestions and experimental appointment attendance estimates. It uses synthetic demo data and is not clinically validated.
- Administrators can manage verified clinic listings.

## Run locally

Requirements: Node.js 18 or newer and npm.

```powershell
cd Healthcare-Consultation-website-master
npm install
npm start
```

Open [http://localhost:3000](http://localhost:3000). Run the test suite with `npm test`.

## Optional AI configuration

AI tools require a Gemini API key configured on the server. Create a key in [Google AI Studio](https://aistudio.google.com/app/apikey), then set it in the PowerShell session before starting the app:

```powershell
$env:GEMINI_API_KEY="your-private-api-key"
npm start
```

Never add API keys or other secrets to source files or commit them. AI responses are informational, can be wrong, and are not diagnoses or prescriptions. The chat does not choose medicines or provide personalized dosing. For emergencies, contact local emergency services.

The optional FastAPI ML service can run locally or through Docker Compose; see the app README for setup. Its models are trained on synthetic data, so reported metrics are not real-world performance. Do not use its no-show estimates to affect access to care.

## Privacy and safety

Location sharing is optional and requires user consent. Coordinates are sent to the CareConnect server and public OpenStreetMap search service for the nearby search and are not saved by CareConnect. AI prompts and uploaded documents are sent to Google's Gemini API for processing; do not submit information unless you accept Google's privacy and data-use terms. External-provider appointment requests are only saved in the user's CareConnect appointment list and must be confirmed directly with that provider.

The detailed setup, AI, location, production, and privacy documentation is in [`Healthcare-Consultation-website-master/README.md`](./Healthcare-Consultation-website-master/README.md).
The app's current limitations and suggested next steps are documented in [`Healthcare-Consultation-website-master/REVIEW_AND_ROADMAP.md`](./Healthcare-Consultation-website-master/REVIEW_AND_ROADMAP.md).
