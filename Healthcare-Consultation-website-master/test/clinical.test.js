const test = require("node:test");
const assert = require("node:assert/strict");
const { encryptionKey, encryptClinicalData, decryptClinicalData, extractReportHistory, extractReportMeasurements } = require("../clinical");

test("encrypts clinical payloads and rejects modified ciphertext", () => {
  const key = encryptionKey("test-only-clinical-encryption-key");
  const encrypted = encryptClinicalData(Buffer.from("patient report data"), key);
  assert.notEqual(encrypted.toString("utf8"), "patient report data");
  assert.equal(decryptClinicalData(encrypted, key).toString("utf8"), "patient report data");
  const modified = Buffer.from(encrypted);
  modified[modified.length - 1] ^= 1;
  assert.throws(() => decryptClinicalData(modified, key));
});

test("keeps prior conditions and current medicines only when explicitly labeled", () => {
  assert.deepEqual(extractReportHistory(
    "Previous conditions: asthma, seasonal allergies\nCurrent medicines: Example A 5 mg; Example B"
  ), {
    conditions: ["asthma", "seasonal allergies"],
    currentMedications: ["Example A 5 mg", "Example B"]
  });
});

test("extracts labeled report measurements without inferring diagnoses", () => {
  const measurements = extractReportMeasurements(
    "Hemoglobin: 11.2 g/dL\nWBC 8,200 cells/uL\nBlood pressure 130/85 mmHg\nWeight 67 kg"
  );
  assert.deepEqual(measurements, [
    { name: "Hemoglobin", value: "11.2", unit: "g/dL" },
    { name: "WBC", value: "8,200", unit: "cells/uL" },
    { name: "Blood pressure", value: "130/85", unit: "mmHg" },
    { name: "Weight", value: "67", unit: "kg" }
  ]);
});
