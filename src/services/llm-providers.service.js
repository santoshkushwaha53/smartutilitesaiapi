/**
 * Multi-provider LLM chat helper (Groq, Gemini, DeepSeek).
 * Keys stay server-side only. Returns parsed JSON when expectJson=true.
 */

const axios = require("axios");

const PROVIDERS = {
  groq: {
    id: "groq",
    label: "Groq",
    envKey: "GROQ_API_KEY",
    modelEnv: "GROQ_MODEL",
    defaultModel: "llama-3.3-70b-versatile",
    kind: "openai",
    baseUrl: "https://api.groq.com/openai/v1/chat/completions",
  },
  gemini: {
    id: "gemini",
    label: "Gemini",
    envKey: "GEMINI_API_KEY",
    modelEnv: "GEMINI_MODEL",
    defaultModel: "gemini-2.0-flash",
    kind: "gemini",
  },
  deepseek: {
    id: "deepseek",
    label: "DeepSeek",
    envKey: "DEEPSEEK_API_KEY",
    modelEnv: "DEEPSEEK_MODEL",
    defaultModel: "deepseek-chat",
    kind: "openai",
    baseUrl: "https://api.deepseek.com/chat/completions",
  },
};

function listProviders() {
  // Groq-only for now; Gemini/DeepSeek remain in PROVIDERS for later.
  return [PROVIDERS.groq].map((p) => ({
    id: p.id,
    label: p.label,
    configured: Boolean(process.env[p.envKey]),
    model: process.env[p.modelEnv] || p.defaultModel,
  }));
}

function getProvider(id) {
  const key = String(id || "groq").trim().toLowerCase();
  // Force Groq until other providers are re-enabled in Admin.
  const provider = PROVIDERS.groq;
  if (key !== "groq" && key !== provider.id) {
    const err = new Error(`Only Groq is enabled right now (requested: ${id}).`);
    err.code = "LLM_PROVIDER_INVALID";
    throw err;
  }
  if (!process.env[provider.envKey]) {
    const err = new Error(
      `${provider.envKey} is not set. Add it to the API .env (and Render) to use ${provider.label}.`
    );
    err.code = "LLM_NOT_CONFIGURED";
    throw err;
  }
  return provider;
}

function stripJsonFences(text) {
  return String(text || "")
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/```\s*$/, "")
    .trim();
}

function parseJsonContent(content) {
  const cleaned = stripJsonFences(content);
  try {
    return JSON.parse(cleaned);
  } catch {
    throw new Error(`AI response was not valid JSON: ${cleaned.slice(0, 400)}`);
  }
}

async function callOpenAiCompatible(provider, system, user, { temperature = 0.4 } = {}) {
  const model = process.env[provider.modelEnv] || provider.defaultModel;
  const response = await axios.post(
    provider.baseUrl,
    {
      model,
      temperature,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
    },
    {
      headers: {
        Authorization: `Bearer ${process.env[provider.envKey]}`,
        "Content-Type": "application/json",
      },
      timeout: 90000,
    }
  );
  const content = response.data?.choices?.[0]?.message?.content;
  if (!content) throw new Error(`${provider.label} returned an empty response`);
  return parseJsonContent(content);
}

async function callGemini(provider, system, user, { temperature = 0.4 } = {}) {
  const model = process.env[provider.modelEnv] || provider.defaultModel;
  const url =
    `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent` +
    `?key=${encodeURIComponent(process.env[provider.envKey])}`;

  const response = await axios.post(
    url,
    {
      systemInstruction: { parts: [{ text: system }] },
      contents: [{ role: "user", parts: [{ text: user }] }],
      generationConfig: {
        temperature,
        responseMimeType: "application/json",
      },
    },
    {
      headers: { "Content-Type": "application/json" },
      timeout: 90000,
    }
  );

  const parts = response.data?.candidates?.[0]?.content?.parts || [];
  const content = parts.map((p) => p.text || "").join("\n").trim();
  if (!content) throw new Error(`${provider.label} returned an empty response`);
  return parseJsonContent(content);
}

/**
 * @param {"groq"|"gemini"|"deepseek"} providerId
 * @param {string} system
 * @param {string} user
 * @param {{ temperature?: number }} [opts]
 */
async function chatJson(providerId, system, user, opts = {}) {
  const provider = getProvider(providerId);
  if (provider.kind === "gemini") {
    return callGemini(provider, system, user, opts);
  }
  return callOpenAiCompatible(provider, system, user, opts);
}

module.exports = {
  PROVIDERS,
  listProviders,
  getProvider,
  chatJson,
};
