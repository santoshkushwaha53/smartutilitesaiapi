const { Pool } = require("pg");

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl:
    process.env.DB_SSL === "true"
      ? { rejectUnauthorized: false }
      : false,
});

async function logApiCall({
  requestId,
  routeName,
  apiName,
  providerName,
  country = "",
  latitude = null,
  longitude = null,
  responseTimeMs,
  httpStatus = null,
  callStatus = "success",
  resultCount = null,
  errorMessage = "",
  extra = {},
}) {
  try {
    await pool.query(
      `
      INSERT INTO public.api_provider_call_log (
        request_id,
        route_name,
        api_name,
        provider_name,
        country,
        latitude,
        longitude,
        response_time_ms,
        http_status,
        call_status,
        result_count,
        error_message,
        extra
      )
      VALUES (
        $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13
      )
      `,
      [
        requestId,
        routeName,
        apiName,
        providerName,
        country || null,
        latitude,
        longitude,
        responseTimeMs,
        httpStatus,
        callStatus,
        resultCount,
        errorMessage || null,
        JSON.stringify(extra || {}),
      ]
    );
  } catch (err) {
    console.error("[api log insert failed]", err.message);
  }
}

module.exports = {
  logApiCall,
};