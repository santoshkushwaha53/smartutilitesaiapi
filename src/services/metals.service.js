const axios = require("axios");
const { PrismaClient } = require("@prisma/client");

const prisma = new PrismaClient();

const METALS_API_URL = "https://api.metals.dev/v1/latest";
const PROVIDER_MIN_AGE_MS = Number(
  process.env.METALS_PROVIDER_MIN_AGE_MS || 39600000
); // 11h
const SCHEDULER_CHECK_MS = Number(
  process.env.METALS_SCHEDULER_CHECK_MS || 1800000
); // 30m
const JOB_NAME = "metals-usd-sync";

let isSyncRunning = false;
let syncTimer = null;

function toGram(ounce) {
  return +(Number(ounce || 0) / 31.1034768).toFixed(6);
}

async function fetchLatestUsdFromProvider() {
  if (!process.env.METALS_DEV_API_KEY) {
    throw new Error("METALS_DEV_API_KEY is missing in .env");
  }

  const response = await axios.get(METALS_API_URL, {
    params: {
      api_key: process.env.METALS_DEV_API_KEY,
      currency: "USD",
      unit: "toz",
    },
    headers: {
      Accept: "application/json",
    },
    timeout: 15000,
  });

  const data = response.data;
  console.log("Metals provider response:", JSON.stringify(data, null, 2));

  const goldOunce = Number(
    data?.metals?.gold ?? data?.gold ?? data?.rates?.XAU ?? 0
  );

  const silverOunce = Number(
    data?.metals?.silver ?? data?.silver ?? data?.rates?.XAG ?? 0
  );

  if (!goldOunce || !silverOunce) {
    throw new Error(
      `Invalid gold/silver values returned by provider: ${JSON.stringify(data)}`
    );
  }

  return {
    source: "metals.dev",
    baseCurrency: "USD",
    unit: "toz",
    goldOunce,
    silverOunce,
    goldGram: toGram(goldOunce),
    silverGram: toGram(silverOunce),
    providerTimestamp: data?.timestamps?.metal
      ? new Date(data.timestamps.metal)
      : new Date(),
  };
}

async function getLastSuccessfulSyncAt() {
  const syncState = await prisma.metal_sync_state.findUnique({
    where: { job_name: JOB_NAME },
  });

  if (syncState?.last_success_at) {
    return new Date(syncState.last_success_at);
  }

  const latestSnapshot = await prisma.metal_price_snapshots.findFirst({
    where: { base_currency: "USD" },
    orderBy: { fetched_at: "desc" },
  });

  return latestSnapshot?.fetched_at ? new Date(latestSnapshot.fetched_at) : null;
}

async function shouldCallProvider() {
  const lastSuccessAt = await getLastSuccessfulSyncAt();

  if (!lastSuccessAt) {
    return {
      shouldSync: true,
      reason: "No previous successful sync found",
    };
  }

  const ageMs = Date.now() - lastSuccessAt.getTime();

  if (ageMs < PROVIDER_MIN_AGE_MS) {
    return {
      shouldSync: false,
      reason: `Last successful sync was ${Math.round(ageMs / 60000)} minutes ago`,
      lastSuccessAt,
      ageMs,
    };
  }

  return {
    shouldSync: true,
    reason: `Last successful sync is older than ${Math.round(
      PROVIDER_MIN_AGE_MS / 3600000
    )} hours`,
    lastSuccessAt,
    ageMs,
  };
}

async function runMetalsSync() {
  if (isSyncRunning) {
    return {
      success: false,
      skipped: true,
      reason: "Sync already running",
    };
  }

  isSyncRunning = true;

  try {
    await prisma.metal_sync_state.upsert({
      where: { job_name: JOB_NAME },
      update: {
        last_run_at: new Date(),
        last_error: null,
      },
      create: {
        job_name: JOB_NAME,
        last_run_at: new Date(),
        last_error: null,
      },
    });

    const latest = await fetchLatestUsdFromProvider();

    const saved = await prisma.metal_price_snapshots.create({
      data: {
        source: latest.source,
        base_currency: latest.baseCurrency,
        unit: latest.unit,
        gold_ounce: latest.goldOunce,
        silver_ounce: latest.silverOunce,
        gold_gram: latest.goldGram,
        silver_gram: latest.silverGram,
        provider_timestamp: latest.providerTimestamp,
      },
    });

    await prisma.metal_sync_state.upsert({
      where: { job_name: JOB_NAME },
      update: {
        last_run_at: new Date(),
        last_success_at: new Date(),
        last_error: null,
      },
      create: {
        job_name: JOB_NAME,
        last_run_at: new Date(),
        last_success_at: new Date(),
        last_error: null,
      },
    });

    const safeSnapshot = {
      id: saved.id.toString(),
      source: saved.source,
      base_currency: saved.base_currency,
      unit: saved.unit,
      gold_ounce: Number(saved.gold_ounce),
      silver_ounce: Number(saved.silver_ounce),
      gold_gram: Number(saved.gold_gram),
      silver_gram: Number(saved.silver_gram),
      provider_timestamp: saved.provider_timestamp,
      fetched_at: saved.fetched_at,
    };

    return {
      success: true,
      skipped: false,
      snapshot: safeSnapshot,
    };
  } catch (error) {
    console.error(
      "Metals sync failed FULL:",
      error?.response?.data || error?.message || error
    );

    try {
      await prisma.metal_sync_state.upsert({
        where: { job_name: JOB_NAME },
        update: {
          last_run_at: new Date(),
          last_error: error?.message || "Unknown sync error",
        },
        create: {
          job_name: JOB_NAME,
          last_run_at: new Date(),
          last_error: error?.message || "Unknown sync error",
        },
      });
    } catch (innerError) {
      console.error(
        "Failed to save sync error state:",
        innerError?.message || innerError
      );
    }

    return {
      success: false,
      skipped: false,
      error: error?.message || "Sync failed",
    };
  } finally {
    isSyncRunning = false;
  }
}

async function runMetalsSyncIfNeeded() {
  const check = await shouldCallProvider();

  if (!check.shouldSync) {
    console.log("Skipping provider sync:", check.reason);

    return {
      success: true,
      skipped: true,
      reason: check.reason,
      lastSuccessAt: check.lastSuccessAt || null,
      ageMs: check.ageMs || 0,
    };
  }

  console.log("Calling provider:", check.reason);
  return runMetalsSync();
}

function startMetalsSyncScheduler() {
  runMetalsSyncIfNeeded().then((result) => {
    console.log("Initial metals sync check:", result);
  });

  syncTimer = setInterval(() => {
    runMetalsSyncIfNeeded().then((result) => {
      console.log("Scheduled metals sync check:", result);
    });
  }, SCHEDULER_CHECK_MS);

  return syncTimer;
}

module.exports = {
  runMetalsSync,
  runMetalsSyncIfNeeded,
  startMetalsSyncScheduler,
};