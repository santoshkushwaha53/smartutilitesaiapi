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
    // Instant model is widely available on Groq free/paid tiers.
    defaultModel: "openai/gpt-oss-20b",
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

function extractJsonObject(text) {
  const cleaned = stripJsonFences(text);
  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");
  if (start >= 0 && end > start) {
    return cleaned.slice(start, end + 1);
  }
  return cleaned;
}

function parseJsonContent(content) {
  const cleaned = extractJsonObject(content);
  try {
    return JSON.parse(cleaned);
  } catch (firstErr) {
    // Common truncation: response cut mid-string. Ask caller to retry;
    // still surface a short preview for debugging.
    const err = new Error(
      `AI response was not valid JSON (often truncated). Preview: ${cleaned.slice(0, 220)}…`
    );
    err.code = "LLM_JSON_PARSE";
    err.raw = cleaned;
    throw err;
  }
}

function providerHttpError(provider, err) {
  const status = err?.response?.status;
  const data = err?.response?.data;
  const detail =
    (typeof data === "string" && data) ||
    data?.error?.message ||
    data?.message ||
    (data ? JSON.stringify(data).slice(0, 400) : "") ||
    err?.message ||
    "Unknown AI provider error";
  const e = new Error(
    status
      ? `${provider.label} API error ${status}: ${detail}`
      : `${provider.label} API error: ${detail}`
  );
  e.code = "LLM_PROVIDER_HTTP";
  e.status = status;
  return e;
}

function buildOpenAiPayload(provider, model, system, user, { temperature = 0.4, maxTokens = 8192 } = {}) {
  const payload = {
    model,
    temperature,
    messages: [
      { role: "system", content: system },
      {
        role: "user",
        content: `${user}\n\nReturn one COMPLETE valid JSON object only. Keep bodyParagraphs short (3-5 sentences each, max 5 paragraphs). Max 4 FAQ items.`,
      },
    ],
  };

  // gpt-oss models on Groq prefer max_completion_tokens; others use max_tokens.
  if (/gpt-oss/i.test(model)) {
    payload.max_completion_tokens = maxTokens;
  } else {
    payload.max_tokens = maxTokens;
  }

  // Helps models that support it; ignore failures via retry without it if needed.
  if (provider.id === "groq" || provider.id === "deepseek") {
    payload.response_format = { type: "json_object" };
  }

  return payload;
}

async function callOpenAiCompatible(provider, system, user, { temperature = 0.4, maxTokens = 8192 } = {}) {
  const model = process.env[provider.modelEnv] || provider.defaultModel;
  try {
    const response = await axios.post(
      provider.baseUrl,
      buildOpenAiPayload(provider, model, system, user, { temperature, maxTokens }),
      {
        headers: {
          Authorization: `Bearer ${process.env[provider.envKey]}`,
          "Content-Type": "application/json",
        },
        timeout: 120000,
      }
    );
    const choice = response.data?.choices?.[0];
    const content = choice?.message?.content;
    const finish = choice?.finish_reason;
    if (!content) throw new Error(`${provider.label} returned an empty response`);
    try {
      return parseJsonContent(content);
    } catch (parseErr) {
      if (finish === "length" || parseErr.code === "LLM_JSON_PARSE") {
        // One compact retry when the first answer was truncated/invalid.
        const retryUser =
          `${user}\n\nIMPORTANT: Previous output was truncated/invalid JSON. ` +
          `Return a SHORTER complete JSON now: title, slug, subtitle, quickSummary, seoTitle, seoDescription, ` +
          `keywords (5), readingMinutes, coverEmoji, contentType, bodyParagraphs (exactly 4 short paragraphs), ` +
          `faq (exactly 3 items), holidayIds, festivalIds, stateCodes, whyNow.`;
        const retry = await axios.post(
          provider.baseUrl,
          buildOpenAiPayload(provider, model, system, retryUser, {
            temperature: 0.2,
            maxTokens: Math.max(maxTokens, 8192),
          }),
          {
            headers: {
              Authorization: `Bearer ${process.env[provider.envKey]}`,
              "Content-Type": "application/json",
            },
            timeout: 120000,
          }
        );
        const retryContent = retry.data?.choices?.[0]?.message?.content;
        if (!retryContent) throw parseErr;
        return parseJsonContent(retryContent);
      }
      throw parseErr;
    }
  } catch (err) {
    if (err.code === "LLM_PROVIDER_HTTP" || err.code === "LLM_JSON_PARSE") throw err;
    if (err?.response) throw providerHttpError(provider, err);
    throw err;
  }
}

async function callGemini(provider, system, user, { temperature = 0.4 } = {}) {
  const model = process.env[provider.modelEnv] || provider.defaultModel;
  const url =
    `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent` +
    `?key=${encodeURIComponent(process.env[provider.envKey])}`;

  try {
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
  } catch (err) {
    if (err.code === "LLM_PROVIDER_HTTP") throw err;
    if (err?.response) throw providerHttpError(provider, err);
    throw err;
  }
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
