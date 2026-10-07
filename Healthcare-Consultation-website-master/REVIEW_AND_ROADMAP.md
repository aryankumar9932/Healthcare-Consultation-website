# Review and roadmap

This document describes the current demonstration app and possible future work. It is not a security certification, clinical validation, or compliance assessment.

## Current scope

- The runnable web app is Node.js/Express. Legacy PHP pages remain in the repository.
- The app stores users and appointments in a JSON file and uses Express's default in-memory session store. These are suitable only for local/demo use, not concurrent or regulated production workloads.
- Patient accounts are supported, but doctor accounts and a doctor portal are not implemented. Appointment slot conflict prevention, reminders, video visits, and payments are not implemented.
- Gemini receives submitted prompts and documents when its features are used. There is no consent workflow, AI audit log, or legal/compliance review built into this demo.
- The optional local ML service can suggest specialties and estimate no-show probability. Its models are trained on generated synthetic data and are not validated for clinical or operational decisions.

## Recommended next work

1. Replace JSON storage with PostgreSQL migrations, appropriate roles, and a production session store; add email verification and password recovery.
2. Implement provider-managed availability and atomic slot booking, then add explicit appointment confirmation and reminder delivery.
3. Add doctor workflows, patient-record access controls, and audit logging only after defining privacy, retention, and access requirements.
4. Add video visits, e-prescriptions, and payments through reviewed providers and secure webhook handling.
5. Complete a jurisdiction-specific privacy and security assessment before using real patient information or presenting this as HIPAA- or DPDP-compliant.
6. Add production observability, rate limiting, CSRF protection, hardened HTTP headers, backups, and deployment health monitoring.
7. Before considering ML for real users, obtain appropriate consent for de-identified training data, perform clinical review, evaluate per-class recall/calibration/subgroup behavior, and continuously monitor drift.

## ML data caveat

The training and test examples are synthetic. Metrics such as the reported specialty accuracy and no-show AUC describe only synthetic holdout samples; they are not real-world performance estimates. Emergency phrase matching is a limited safety rule, not a complete triage system. The no-show model must never be used to deny, delay, penalize, or overbook care. At most, the demo can use its output to suggest an additional reminder.

See the app [README](./README.md) for local service setup and privacy details.
