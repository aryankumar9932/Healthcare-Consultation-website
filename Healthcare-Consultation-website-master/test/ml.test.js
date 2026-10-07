const test = require("node:test");
const assert = require("node:assert/strict");
const {
  analyzeDocument,
  chatWithHealthAssistant,
  normalizeDocumentAnalysis,
  normalizeHealthChat,
  normalizeNoShow,
  normalizePrescriptionAnalysis,
  normalizeRecommendation,
  parseStructuredResponse
} = require("../ml");

test("parses JSON responses with an optional markdown fence", () => {
  assert.deepEqual(parseStructuredResponse('```json\n{"ok":true}\n```'), { ok: true });
});

test("calls Gemini with the server-side API key and inline document image", async t => {
  const originalFetch = global.fetch;
  const originalApiKey = process.env.GEMINI_API_KEY;
  const originalModel = process.env.GEMINI_MODEL;
  process.env.GEMINI_API_KEY = "test-api-key";
  process.env.GEMINI_MODEL = "test-vision-model";
  let apiRequest;
  let requestUrl;
  global.fetch = async (url, options) => {
    requestUrl = url;
    apiRequest = { headers: options.headers, body: JSON.parse(options.body) };
    return new Response(JSON.stringify({
      candidates: [{ content: { parts: [{ text: JSON.stringify({
        summary: "A routine test report.",
        keyFindings: ["The image contains a test report."],
        questions: ["What does this result mean?"]
      }) }] } }]
    }), { headers: { "Content-Type": "application/json" } });
  };
  t.after(() => {
    global.fetch = originalFetch;
    if (originalApiKey === undefined) delete process.env.GEMINI_API_KEY;
    else process.env.GEMINI_API_KEY = originalApiKey;
    if (originalModel === undefined) delete process.env.GEMINI_MODEL;
    else process.env.GEMINI_MODEL = originalModel;
  });

  await analyzeDocument({
    image: { mime: "image/png", data: "aGVsbG8=" }
  });

  assert.equal(requestUrl, "https://generativelanguage.googleapis.com/v1beta/models/test-vision-model:generateContent");
  assert.equal(apiRequest.headers["x-goog-api-key"], "test-api-key");
  assert.deepEqual(apiRequest.body.generationConfig, {
    temperature: 0.1,
    responseMimeType: "application/json"
  });
  assert.deepEqual(apiRequest.body.contents[0].parts[1], {
    inlineData: { mimeType: "image/png", data: "aGVsbG8=" }
  });
});

test("limits specialty recommendations to the available catalogue", () => {
  const result = normalizeRecommendation({
    specialty: "cardiologist",
    rationale: "A heart specialist can assess this concern.",
    urgency: "soon"
  }, ["Cardiologist", "Dentist"]);
  assert.equal(result.specialty, "Cardiologist");
  assert.equal(result.urgency, "soon");
  assert.throws(() => normalizeRecommendation({
    specialty: "Unsupported specialty",
    rationale: "Not available.",
    urgency: "routine"
  }, ["Cardiologist"]));
});

test("validates attendance estimates rather than accepting malformed model output", () => {
  const result = normalizeNoShow({ probability: 23.7, risk: "moderate", factors: ["Short notice booking"] });
  assert.equal(result.probability, 24);
  assert.equal(result.risk, "moderate");
  assert.throws(() => normalizeNoShow({ probability: 140, risk: "high", factors: [] }));
});

test("requires structured document summary fields", () => {
  const result = normalizeDocumentAnalysis({
    summary: "A routine test report.",
    keyFindings: ["The report lists a test result."],
    questions: ["What does this result mean for me?"]
  });
  assert.equal(result.keyFindings.length, 1);
  assert.throws(() => normalizeDocumentAnalysis({ summary: "Incomplete response." }));
});

test("validates health chat responses and care timing", () => {
  const result = normalizeHealthChat({ reply: "Please contact a clinician today.", careTiming: "same-day" });
  assert.equal(result.careTiming, "same-day");
  assert.match(result.disclaimer, /not a diagnosis/i);
  assert.throws(() => normalizeHealthChat({ reply: "Take this medicine.", careTiming: "whenever" }));
});

test("sends health chat history and attachments through the server-side Gemini client", async t => {
  const originalFetch = global.fetch;
  const originalApiKey = process.env.GEMINI_API_KEY;
  process.env.GEMINI_API_KEY = "test-api-key";
  let apiRequest;
  global.fetch = async (url, options) => {
    apiRequest = { url, headers: options.headers, body: JSON.parse(options.body) };
    return new Response(JSON.stringify({
      candidates: [{ content: { parts: [{ text: JSON.stringify({
        reply: "I can explain the wording, but a pharmacist should confirm it.",
        careTiming: "routine"
      }) }] } }]
    }), { headers: { "Content-Type": "application/json" } });
  };
  t.after(() => {
    global.fetch = originalFetch;
    if (originalApiKey === undefined) delete process.env.GEMINI_API_KEY;
    else process.env.GEMINI_API_KEY = originalApiKey;
  });

  const result = await chatWithHealthAssistant({
    message: "What does this label say?",
    history: [{ role: "user", content: "I have a label." }],
    image: { mime: "application/pdf", data: "cGRm" }
  });

  assert.equal(result.careTiming, "routine");
  assert.equal(apiRequest.headers["x-goog-api-key"], "test-api-key");
  assert.deepEqual(apiRequest.body.contents[0].parts[1], {
    inlineData: { mimeType: "application/pdf", data: "cGRm" }
  });
  assert.match(apiRequest.body.systemInstruction.parts[0].text, /Never provide a personalized dose/);
  assert.deepEqual(JSON.parse(apiRequest.body.contents[0].parts[0].text).recentConversation, [
    { role: "user", content: "I have a label." }
  ]);
});

test("matches extracted prescription items to exact catalogue products and calculates listed rates", () => {
  const products = [
    { id: 2, name: "Napa 500mg", price: 50 },
    { id: 3, name: "Sugatrol 100mg 10pcs", price: 240 }
  ];
  const result = normalizePrescriptionAnalysis({
    medicines: [
      { name: "Napa", strength: "500mg", quantity: 2, quantityUnit: "strips" },
      { name: "Unknown medicine", strength: null, quantity: null, quantityUnit: null }
    ]
  }, products);
  assert.deepEqual(result.medicines[0].product, {
    id: 2,
    name: "Napa 500mg",
    rate: 50,
    lineTotal: 100
  });
  assert.equal(result.medicines[0].quantity, 2);
  assert.equal(result.medicines[1].product, null);
  assert.throws(() => normalizePrescriptionAnalysis({
    medicines: [{ name: "Napa", strength: "500mg", quantity: -2 }]
  }, products));
  assert.throws(() => normalizePrescriptionAnalysis({ medicines: [null] }, products));
});
