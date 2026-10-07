const crypto = require("crypto");

function encryptionKey(secret) {
  return crypto.createHash("sha256").update(secret).digest();
}

function encryptClinicalData(value, key) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([cipher.update(value), cipher.final()]);
  return Buffer.concat([Buffer.from([1]), iv, cipher.getAuthTag(), ciphertext]);
}

function decryptClinicalData(envelope, key) {
  if (!Buffer.isBuffer(envelope) || envelope.length < 30 || envelope[0] !== 1) {
    throw new Error("The encrypted clinical record is invalid.");
  }
  const decipher = crypto.createDecipheriv("aes-256-gcm", key, envelope.subarray(1, 13));
  decipher.setAuthTag(envelope.subarray(13, 29));
  return Buffer.concat([decipher.update(envelope.subarray(29)), decipher.final()]);
}

function extractReportMeasurements(text) {
  const measurements = [];
  const patterns = [
    { name: "Hemoglobin", pattern: /\b(?:hemoglobin|haemoglobin|hgb)\s*[:=-]?\s*(\d+(?:\.\d+)?)\s*(g\/?dL|g\/L)?/ig },
    { name: "WBC", pattern: /\b(?:wbc|white blood cells?)\s*[:=-]?\s*([\d,]+(?:\.\d+)?)\s*((?:cells?\/?(?:µ|u)?L)|(?:\/?cumm)|(?:10\^?3\/?(?:µ|u)?L))?/ig },
    { name: "Blood pressure", pattern: /\b(?:blood pressure|bp)\s*[:=-]?\s*(\d{2,3}\s*\/\s*\d{2,3})\s*(mmhg)?/ig },
    { name: "Weight", pattern: /\bweight\s*[:=-]?\s*(\d+(?:\.\d+)?)\s*(kg|lb|lbs)?/ig },
    { name: "Glucose", pattern: /\b(?:blood glucose|glucose|blood sugar)\s*[:=-]?\s*(\d+(?:\.\d+)?)\s*(mg\/?dL|mmol\/?L)?/ig }
  ];
  for (const { name, pattern } of patterns) {
    for (const match of text.matchAll(pattern)) {
      measurements.push({ name, value: match[1].replace(/\s+/g, ""), unit: match[2] || "" });
      if (measurements.length === 50) return measurements;
    }
  }
  return measurements;
}

function extractReportHistory(text) {
  const conditions = [];
  const currentMedications = [];
  for (const line of text.split(/\r?\n/)) {
    const conditionMatch = line.match(/^\s*(?:previous conditions|past medical history|medical history|conditions?)\s*[:=-]\s*(.+?)\s*$/i);
    const medicationMatch = line.match(/^\s*(?:current medicines|current medications|medications|medicines)\s*[:=-]\s*(.+?)\s*$/i);
    const values = (conditionMatch?.[1] || medicationMatch?.[1] || "").split(/[,;|]/)
      .map(value => value.trim().slice(0, 160)).filter(Boolean).slice(0, 10);
    if (conditionMatch) conditions.push(...values);
    if (medicationMatch) currentMedications.push(...values);
  }
  return { conditions: conditions.slice(0, 20), currentMedications: currentMedications.slice(0, 20) };
}

module.exports = { encryptionKey, encryptClinicalData, decryptClinicalData, extractReportMeasurements, extractReportHistory };
