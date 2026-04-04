mkdir -p scripts logs/guest_backfill_throttled
cat > scripts/backfill_guest_all_throttled.sh <<'BASH'
#!/usr/bin/env bash
set -euo pipefail

BASE="http://localhost:4000/api/horoscope/get"
SYSTEM="${SYSTEM:-western}"        # or "vedic"
LANG="${LANG:-en}"
TONE="${TONE:-concise}"

SIGNS=(aries taurus gemini cancer leo virgo libra scorpio sagittarius capricorn aquarius pisces)
PERIODS=(yesterday today tomorrow weekly monthly yearly)
TOPICS='["general","love","career","money","health","relationships","numerology","lucky_number","lucky_color"]'

SLEEP_SECS="${SLEEP_SECS:-15}"     # keep under provider limit (<=5 req/min)

OUT="logs/guest_backfill_throttled"
mkdir -p "$OUT"

echo "=== Guest backfill (throttled) ==="
echo "BASE=$BASE"
echo "SYSTEM=$SYSTEM  LANG=$LANG  TONE=$TONE"
echo "SLEEP=$SLEEP_SECS seconds between calls"
echo "-----------------------------------"

for period in "${PERIODS[@]}"; do
  for sign in "${SIGNS[@]}"; do
    body=$(cat <<JSON
{
  "audience":"generic",
  "sign":"$sign",
  "system":"$SYSTEM",
  "period":"$period",
  "topics": $TOPICS,
  "lang":"$LANG",
  "tone":"$TONE"
}
JSON
)
    outfile="$OUT/${period}_${sign}.json"
    echo "→ $sign / $period"
    httpcode=$(curl -sS -o "$outfile" -w "%{http_code}" \
      -X POST "$BASE" -H 'Content-Type: application/json' -d "$body")

    if [[ "$httpcode" == "200" ]]; then
      echo "  ✓ saved: $outfile"
    else
      echo "  ✗ HTTP $httpcode (see file): $outfile"
    fi

    echo "  ⏳ sleep ${SLEEP_SECS}s..."
    sleep "$SLEEP_SECS"
  done
done

echo "✅ Completed. Example: cat $OUT/today_leo.json | jq ."
BASH
chmod +x scripts/backfill_guest_all_throttled.sh
