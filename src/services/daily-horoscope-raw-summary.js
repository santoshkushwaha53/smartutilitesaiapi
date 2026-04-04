// src/services/daily-horoscope-raw-summary.js
import pool from "../../src/db.js";

/* ------------------------------
   UTC Date helpers
------------------------------ */

function toYMD(dt) {
  const y = dt.getUTCFullYear();
  const m = String(dt.getUTCMonth() + 1).padStart(2, "0");
  const d = String(dt.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

function parseYMD(ymd) {
  return new Date(`${ymd}T00:00:00Z`);
}

export function utcTodayYMD() {
  return toYMD(new Date());
}

export function addDaysYMD(ymd, days) {
  const dt = parseYMD(ymd);
  dt.setUTCDate(dt.getUTCDate() + days);
  return toYMD(dt);
}

function weekStartMonday(ymd) {
  const dt = parseYMD(ymd);
  const dow = dt.getUTCDay(); // Sun=0..Sat=6
  const diffToMon = dow === 0 ? -6 : 1 - dow;
  dt.setUTCDate(dt.getUTCDate() + diffToMon);
  return toYMD(dt);
}

function weekRangeMonSun(ymd) {
  const start = weekStartMonday(ymd);
  const end = addDaysYMD(start, 6);
  return { start, end };
}

function monthStartEnd(year, month1to12) {
  const start = new Date(Date.UTC(year, month1to12 - 1, 1));
  const end = new Date(Date.UTC(year, month1to12, 0));
  const monthName = start.toLocaleString("en-US", { month: "long", timeZone: "UTC" });
  return { start: toYMD(start), end: toYMD(end), monthName };
}

function listWeeksForMonth(year, month1to12) {
  const { start: mStart, end: mEnd, monthName } = monthStartEnd(year, month1to12);
  const firstWeekStart = weekStartMonday(mStart);

  const weeks = [];
  let cur = firstWeekStart;
  while (cur <= mEnd) {
    const { start, end } = weekRangeMonSun(cur);
    weeks.push({ start, end });
    cur = addDaysYMD(cur, 7);
  }

  return { monthStart: mStart, monthEnd: mEnd, monthName, weeks };
}

/* ------------------------------
   DB helpers (cache table)
------------------------------ */

async function upsertCacheRow(client, row) {
  const sql = `
    INSERT INTO public.astro_sign_bundle_cache
      (system, lang, sign_id, duration,
       ref_date, range_start, range_end,
       month_name, year_from, year_to,
       calc_ts_utc, bundle)
    VALUES
      ($1,$2,$3,$4,
       $5::date,$6::date,$7::date,
       $8,$9,$10,
       (now() AT TIME ZONE 'UTC'), $11::jsonb)
    ON CONFLICT (system, lang, sign_id, duration,
                 COALESCE(ref_date, range_start),
                 COALESCE(range_end, range_start))
    DO UPDATE SET
      bundle = EXCLUDED.bundle,
      calc_ts_utc = EXCLUDED.calc_ts_utc,
      month_name = EXCLUDED.month_name,
      year_from = EXCLUDED.year_from,
      year_to = EXCLUDED.year_to
    RETURNING id;
  `;

  const params = [
    row.system,
    row.lang,
    row.signId,
    row.duration,
    row.refDate || null,
    row.rangeStart || null,
    row.rangeEnd || null,
    row.monthName || null,
    row.yearFrom || null,
    row.yearTo || null,
    JSON.stringify(row.bundle),
  ];

  const { rows } = await client.query(sql, params);
  return rows[0];
}

async function getCacheByKey(client, { system, lang, signId, duration, refDate, rangeStart, rangeEnd }) {
  const sql = `
    SELECT bundle
    FROM public.astro_sign_bundle_cache
    WHERE system=$1 AND lang=$2 AND sign_id=$3 AND duration=$4
      AND COALESCE(ref_date, range_start) = COALESCE($5::date, $6::date)
      AND COALESCE(range_end, range_start) = COALESCE($7::date, $6::date)
    LIMIT 1
  `;

  const { rows } = await client.query(sql, [
    system,
    lang,
    signId,
    duration,
    refDate || null,
    rangeStart || null,
    rangeEnd || null,
  ]);

  return rows[0]?.bundle || null;
}

/* ------------------------------
   Build bundle by SQL function
------------------------------ */

async function buildBundleViaSQL(client, { system, lang, signId, duration, dStart, dEnd, refDateUtc }) {
  const sql = `SELECT public.fn_build_sign_bundle($1,$2,$3,$4,$5::date,$6::date,$7::date) AS bundle`;
  const { rows } = await client.query(sql, [system, lang, signId, duration, dStart, dEnd, refDateUtc]);
  const bundle = rows?.[0]?.bundle;
  if (!bundle || bundle.status !== "ok") {
    throw new Error(`fn_build_sign_bundle failed sign=${signId} duration=${duration}`);
  }
  return bundle;
}

/* =========================================================
   EXPORTS USED BY ROUTES
========================================================= */

export async function buildDailyAndCurrentWeekly({ system, lang }) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SET TIME ZONE 'UTC'");

    const today = utcTodayYMD();
    const targets = [
      { duration: "yesterday", d: addDaysYMD(today, -1) },
      { duration: "today", d: today },
      { duration: "tomorrow", d: addDaysYMD(today, 1) },
    ];
    const wk = weekRangeMonSun(today);

    let insertedOrUpdated = 0;

    for (let signId = 1; signId <= 12; signId++) {
      for (const t of targets) {
        const existing = await getCacheByKey(client, {
          system, lang, signId, duration: t.duration, refDate: t.d,
        });
        if (existing) continue;

        const bundle = await buildBundleViaSQL(client, {
          system, lang, signId,
          duration: t.duration,
          dStart: t.d,
          dEnd: t.d,
          refDateUtc: today,
        });

        await upsertCacheRow(client, {
          system, lang, signId,
          duration: t.duration,
          refDate: t.d,
          bundle,
        });

        insertedOrUpdated++;
      }

      const existingW = await getCacheByKey(client, {
        system, lang, signId, duration: "weekly", rangeStart: wk.start, rangeEnd: wk.end,
      });
      if (!existingW) {
        const bundle = await buildBundleViaSQL(client, {
          system, lang, signId,
          duration: "weekly",
          dStart: wk.start,
          dEnd: wk.end,
          refDateUtc: today,
        });

        await upsertCacheRow(client, {
          system, lang, signId,
          duration: "weekly",
          rangeStart: wk.start,
          rangeEnd: wk.end,
          bundle,
        });

        insertedOrUpdated++;
      }
    }

    await client.query("COMMIT");
    return { status: "ok", insertedOrUpdated, weeklyRange: wk, daily: targets.map(x => x.duration) };
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
}

export async function buildDailyUntilYearEnd({ system, lang, year }) {
  if (!year) throw new Error("year required");

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SET TIME ZONE 'UTC'");

    const today = utcTodayYMD();
    const start = addDaysYMD(today, -1);
    const end = `${year}-12-31`;

    let inserted = 0;

    for (let d = start; d <= end; d = addDaysYMD(d, 1)) {
      for (let signId = 1; signId <= 12; signId++) {
        const existing = await getCacheByKey(client, {
          system, lang, signId, duration: "daily", refDate: d,
        });
        if (existing) continue;

        const bundle = await buildBundleViaSQL(client, {
          system, lang, signId,
          duration: "daily",
          dStart: d,
          dEnd: d,
          refDateUtc: today,
        });

        await upsertCacheRow(client, {
          system, lang, signId,
          duration: "daily",
          refDate: d,
          bundle,
        });

        inserted++;
      }
    }

    await client.query("COMMIT");
    return { status: "ok", duration: "daily", range: { start, end }, inserted };
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
}

export async function ensureWeeklyForMonth({ system, lang, year, month }) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SET TIME ZONE 'UTC'");

    const today = utcTodayYMD();
    const { monthStart, monthEnd, weeks } = listWeeksForMonth(year, month);

    let insertedOrUpdated = 0;

    for (const wk of weeks) {
      for (let signId = 1; signId <= 12; signId++) {
        const existing = await getCacheByKey(client, {
          system, lang, signId, duration: "weekly",
          rangeStart: wk.start, rangeEnd: wk.end,
        });
        if (existing) continue;

        const bundle = await buildBundleViaSQL(client, {
          system, lang, signId,
          duration: "weekly",
          dStart: wk.start,
          dEnd: wk.end,
          refDateUtc: today,
        });

        await upsertCacheRow(client, {
          system, lang, signId,
          duration: "weekly",
          rangeStart: wk.start,
          rangeEnd: wk.end,
          bundle,
        });

        insertedOrUpdated++;
      }
    }

    await client.query("COMMIT");
    return { status: "ok", year, month, range: { start: monthStart, end: monthEnd }, weeks: weeks.length, insertedOrUpdated };
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
}

export async function ensureMonthly({ system, lang, year, month }) {
  await ensureWeeklyForMonth({ system, lang, year, month });

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SET TIME ZONE 'UTC'");

    const today = utcTodayYMD();
    const { monthStart, monthEnd, monthName, weeks } = listWeeksForMonth(year, month);

    let insertedOrUpdated = 0;

    for (let signId = 1; signId <= 12; signId++) {
      const existingMonthly = await getCacheByKey(client, {
        system, lang, signId, duration: "monthly",
        rangeStart: monthStart, rangeEnd: monthEnd,
      });
      if (existingMonthly) continue;

      const q = `
        SELECT range_start, range_end, bundle
        FROM public.astro_sign_bundle_cache
        WHERE system=$1 AND lang=$2 AND sign_id=$3 AND duration='weekly'
          AND range_start >= $4::date - 14
          AND range_start <= $5::date + 14
        ORDER BY range_start ASC
      `;
      const { rows } = await client.query(q, [system, lang, signId, monthStart, monthEnd]);

      const dayMap = new Map();
      for (const r of rows) {
        const b = r.bundle;
        const days = b?.days || [];
        for (const dj of days) {
          const d = dj?.date;
          if (!d) continue;
          if (d < monthStart || d > monthEnd) continue;
          dayMap.set(d, dj);
        }
      }

      const mergedDays = Array.from(dayMap.entries())
        .sort((a, b) => (a[0] < b[0] ? -1 : 1))
        .map((x) => x[1]);

      const bundle = {
        status: "ok",
        system,
        lang,
        signId,
        duration: "monthly",
        refDate: today,
        calcTs: new Date().toISOString(),
        month: { name: monthName, year },
        dateRange: { start: monthStart, end: monthEnd },
        source: { weeklyWeeksCount: weeks.length },
        days: mergedDays,
      };

      await upsertCacheRow(client, {
        system, lang, signId,
        duration: "monthly",
        rangeStart: monthStart,
        rangeEnd: monthEnd,
        monthName,
        yearFrom: year,
        yearTo: year,
        bundle,
      });

      insertedOrUpdated++;
    }

    await client.query("COMMIT");
    return { status: "ok", year, month, monthName, range: { start: monthStart, end: monthEnd }, insertedOrUpdated };
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
}

export async function ensureYearly({ system, lang, year }) {
  for (let m = 1; m <= 12; m++) {
    await ensureMonthly({ system, lang, year, month: m });
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SET TIME ZONE 'UTC'");

    const today = utcTodayYMD();
    const yStart = `${year}-01-01`;
    const yEnd = `${year}-12-31`;

    let insertedOrUpdated = 0;

    for (let signId = 1; signId <= 12; signId++) {
      const existingYear = await getCacheByKey(client, {
        system, lang, signId, duration: "yearly",
        rangeStart: yStart, rangeEnd: yEnd,
      });
      if (existingYear) continue;

      const q = `
        SELECT range_start, range_end, month_name, bundle
        FROM public.astro_sign_bundle_cache
        WHERE system=$1 AND lang=$2 AND sign_id=$3 AND duration='monthly'
          AND year_from=$4 AND year_to=$4
        ORDER BY range_start ASC
      `;
      const { rows } = await client.query(q, [system, lang, signId, year]);

      const dayMap = new Map();
      const months = [];

      for (const r of rows) {
        months.push({ start: r.range_start, end: r.range_end, name: r.month_name });
        const b = r.bundle;
        const days = b?.days || [];
        for (const dj of days) {
          const d = dj?.date;
          if (!d) continue;
          if (d < yStart || d > yEnd) continue;
          dayMap.set(d, dj);
        }
      }

      const mergedDays = Array.from(dayMap.entries())
        .sort((a, b) => (a[0] < b[0] ? -1 : 1))
        .map((x) => x[1]);

      const bundle = {
        status: "ok",
        system,
        lang,
        signId,
        duration: "yearly",
        refDate: today,
        calcTs: new Date().toISOString(),
        year: { from: year, to: year },
        dateRange: { start: yStart, end: yEnd },
        source: { monthsCount: months.length, months },
        days: mergedDays,
      };

      await upsertCacheRow(client, {
        system, lang, signId,
        duration: "yearly",
        rangeStart: yStart,
        rangeEnd: yEnd,
        yearFrom: year,
        yearTo: year,
        bundle,
      });

      insertedOrUpdated++;
    }

    await client.query("COMMIT");
    return { status: "ok", year, range: { start: yStart, end: yEnd }, insertedOrUpdated };
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
}

export async function getDailyByDate({ system, lang, date }) {
  if (!date) throw new Error("date is required (YYYY-MM-DD)");

  const client = await pool.connect();
  try {
    await client.query("SET TIME ZONE 'UTC'");

    const sql = `
      SELECT sign_id, ref_date, bundle
      FROM public.astro_sign_bundle_cache
      WHERE system=$1 AND lang=$2
        AND duration='daily'
        AND ref_date=$3::date
      ORDER BY sign_id;
    `;

    const { rows } = await client.query(sql, [system, lang, date]);

    return {
      status: "ok",
      system,
      lang,
      duration: "daily",
      date,
      count: rows.length,
      signs: rows.map((r) => ({
        signId: r.sign_id,
        refDate: r.ref_date,
        bundle: r.bundle,
      })),
    };
  } finally {
    client.release();
  }
}

/* =========================================================
   ✅ NEW: Ensure + Verify all snapshots
========================================================= */

async function countByDuration(client, { system, lang, duration, whereSql, whereParams }) {
  const q = `
    SELECT count(*)::int AS c
    FROM public.astro_sign_bundle_cache
    WHERE system=$1 AND lang=$2 AND duration=$3
    ${whereSql || ""}
  `;
  const { rows } = await client.query(q, [system, lang, duration, ...(whereParams || [])]);
  return rows[0]?.c || 0;
}

export async function ensureAllSnapshots({ system, lang, year, month }) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SET TIME ZONE 'UTC'");

    const today = utcTodayYMD();
    const yday = addDaysYMD(today, -1);
    const tmrw = addDaysYMD(today, 1);

    const dt = new Date(`${today}T00:00:00Z`);
    const curYear = dt.getUTCFullYear();
    const curMonth = dt.getUTCMonth() + 1;

    const targetYear = year || curYear;
    const targetMonth = month || curMonth;

    const dailyWeeklyResult = await buildDailyAndCurrentWeekly({ system, lang });
    const weeklyMonthResult = await ensureWeeklyForMonth({ system, lang, year: targetYear, month: targetMonth });
    const monthlyResult = await ensureMonthly({ system, lang, year: targetYear, month: targetMonth });
    const yearlyResult = await ensureYearly({ system, lang, year: targetYear });

    const counts = {
      yesterday: await countByDuration(client, {
        system, lang, duration: "yesterday",
        whereSql: " AND ref_date=$4::date",
        whereParams: [yday],
      }),
      today: await countByDuration(client, {
        system, lang, duration: "today",
        whereSql: " AND ref_date=$4::date",
        whereParams: [today],
      }),
      tomorrow: await countByDuration(client, {
        system, lang, duration: "tomorrow",
        whereSql: " AND ref_date=$4::date",
        whereParams: [tmrw],
      }),
      weekly_current: await countByDuration(client, {
        system, lang, duration: "weekly",
        whereSql: " AND range_start=$4::date AND range_end=$5::date",
        whereParams: [dailyWeeklyResult.weeklyRange.start, dailyWeeklyResult.weeklyRange.end],
      }),
      monthly: await countByDuration(client, {
        system, lang, duration: "monthly",
        whereSql: " AND range_start=$4::date AND range_end=$5::date",
        whereParams: [monthlyResult.range.start, monthlyResult.range.end],
      }),
      yearly: await countByDuration(client, {
        system, lang, duration: "yearly",
        whereSql: " AND range_start=$4::date AND range_end=$5::date",
        whereParams: [yearlyResult.range.start, yearlyResult.range.end],
      }),
    };

    await client.query("COMMIT");

    return {
      status: "ok",
      system,
      lang,
      ensured: {
        dailyWeeklyResult,
        weeklyMonthResult,
        monthlyResult,
        yearlyResult,
      },
      verify: {
        expectedPerSign: 12,
        counts,
      },
    };
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
}
export async function buildDailyForFullYear({ system, lang, year, force = false }) {
  if (!year) throw new Error("year required");

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SET TIME ZONE 'UTC'");

    const today = utcTodayYMD();           // used as refDateUtc for calculation timestamp
    const start = `${year}-01-01`;
    const end = `${year}-12-31`;

    let inserted = 0;
    let updated = 0;
    let skipped = 0;

    for (let d = start; d <= end; d = addDaysYMD(d, 1)) {
      for (let signId = 1; signId <= 12; signId++) {
        const existing = await getCacheByKey(client, {
          system,
          lang,
          signId,
          duration: "daily",
          refDate: d,
        });

        if (existing && !force) {
          skipped++;
          continue;
        }

        const bundle = await buildBundleViaSQL(client, {
          system,
          lang,
          signId,
          duration: "daily",
          dStart: d,
          dEnd: d,
          refDateUtc: today,
        });

        await upsertCacheRow(client, {
          system,
          lang,
          signId,
          duration: "daily",
          refDate: d,
          bundle,
        });

        if (existing) updated++;
        else inserted++;
      }
    }

    await client.query("COMMIT");

    return {
      status: "ok",
      system,
      lang,
      duration: "daily",
      year,
      range: { start, end },
      expectedRows: isLeapYear(year) ? 366 * 12 : 365 * 12,
      inserted,
      updated,
      skipped,
      force,
    };
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
}

// helper (put anywhere in file)
function isLeapYear(y) {
  return (y % 4 === 0 && y % 100 !== 0) || (y % 400 === 0);
}
