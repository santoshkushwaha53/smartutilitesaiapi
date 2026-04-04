-- =========================================
-- helper: normalize code
-- =========================================
CREATE OR REPLACE FUNCTION util_upper_trim(txt text)
RETURNS text LANGUAGE sql IMMUTABLE AS $$
  SELECT UPPER(BTRIM($1));
$$;

-- =========================================
-- LOOKUP: unique→global fallback + safer caps
-- =========================================
CREATE OR REPLACE FUNCTION promo_lookup(p_code text, p_user_id uuid DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
AS $$
DECLARE
  v_code text := util_upper_trim(p_code);
  now_ts timestamptz := NOW();
  r RECORD;            -- chosen promo row
  u RECORD;            -- unique candidate
  g RECORD;            -- global candidate
  global_redemptions int;
  user_redemptions   int;
BEGIN
  IF v_code IS NULL OR v_code = '' THEN RAISE EXCEPTION 'Missing code'; END IF;

  -- unique candidate (no lock on lookup)
  SELECT p.*, pc.id AS pc_id, pc.is_blocked AS pc_is_blocked, pc.claimed_by_user AS pc_claimed_by_user
    INTO u
    FROM promo_codes pc
    JOIN promotions p ON p.id = pc.promo_id
   WHERE pc.code = v_code
   LIMIT 1;

  -- global candidate
  SELECT p.*, NULL::uuid AS pc_id, FALSE AS pc_is_blocked, NULL::uuid AS pc_claimed_by_user
    INTO g
    FROM promotions p
   WHERE p.code = v_code AND p.kind = 'global_code'
   LIMIT 1;

  -- choose
  IF u.pc_id IS NOT NULL THEN
    IF u.pc_is_blocked THEN
      IF g.id IS NOT NULL THEN r := g; ELSE RAISE EXCEPTION 'Code blocked'; END IF;
    ELSIF u.pc_claimed_by_user IS NOT NULL AND (p_user_id IS NULL OR u.pc_claimed_by_user <> p_user_id) THEN
      IF g.id IS NOT NULL THEN r := g; ELSE RAISE EXCEPTION 'Code already claimed'; END IF;
    ELSE
      r := u;
    END IF;
  ELSIF g.id IS NOT NULL THEN
    r := g;
  ELSE
    RAISE EXCEPTION 'Code not found';
  END IF;

  -- promo window/status
  IF r.status <> 'active' THEN RAISE EXCEPTION 'Promotion not active'; END IF;
  IF NOT (now_ts BETWEEN r.start_at AND r.end_at) THEN RAISE EXCEPTION 'Promotion not in valid window'; END IF;

  -- caps: count only redeemed; enforce only when > 0
  SELECT COUNT(*)::int INTO global_redemptions
  FROM user_promotions up
  WHERE up.promo_id = r.id
    AND up.status   = 'redeemed';

  IF r.max_global_redemptions IS NOT NULL AND r.max_global_redemptions > 0
     AND global_redemptions >= r.max_global_redemptions THEN
    RAISE EXCEPTION 'Global redemption limit reached';
  END IF;

  IF p_user_id IS NOT NULL THEN
    SELECT COUNT(*)::int INTO user_redemptions
    FROM user_promotions up
    WHERE up.promo_id = r.id
      AND up.user_id  = p_user_id
      AND up.status   = 'redeemed';

    IF r.max_per_user IS NOT NULL AND r.max_per_user > 0
       AND user_redemptions >= r.max_per_user THEN
      RAISE EXCEPTION 'You have already used this promotion';
    END IF;
  END IF;

  RETURN jsonb_build_object(
    'promoId', r.id,
    'code', v_code,
    'name', r.name,
    'planLabel', r.description,
    'points', r.points,
    'days', r.days_valid,
    'startAt', r.start_at,
    'endAt', r.end_at
  );
END;
$$;

-- =========================================
-- REDEEM: unique→global fallback (locked) + safer caps
-- =========================================
CREATE OR REPLACE FUNCTION promo_redeem(p_user_id uuid, p_code text)
RETURNS jsonb
LANGUAGE plpgsql
AS $$
DECLARE
  v_code text := util_upper_trim(p_code);
  now_ts timestamptz := NOW();
  r RECORD;            -- chosen promo row (locked)
  u RECORD;            -- unique candidate (locked)
  g RECORD;            -- global candidate (locked)
  global_count int;
  user_count   int;
  v_user_promo_id uuid;
  v_expires_at timestamptz;
BEGIN
  IF p_user_id IS NULL THEN RAISE EXCEPTION 'Unauthorized'; END IF;
  IF v_code IS NULL OR v_code = '' THEN RAISE EXCEPTION 'Missing code'; END IF;

  -- lock unique candidate
  SELECT p.*, pc.id AS pc_id, pc.is_blocked AS pc_is_blocked, pc.claimed_by_user AS pc_claimed_by_user
    INTO u
    FROM promo_codes pc
    JOIN promotions p ON p.id = pc.promo_id
   WHERE pc.code = v_code
   FOR UPDATE;

  -- lock global candidate
  SELECT p.*, NULL::uuid AS pc_id, FALSE AS pc_is_blocked, NULL::uuid AS pc_claimed_by_user
    INTO g
    FROM promotions p
   WHERE p.code = v_code AND p.kind = 'global_code'
   FOR UPDATE;

  -- choose
  IF u.pc_id IS NOT NULL THEN
    IF u.pc_is_blocked THEN
      IF g.id IS NOT NULL THEN r := g; ELSE RAISE EXCEPTION 'Code blocked'; END IF;
    ELSIF u.pc_claimed_by_user IS NOT NULL AND u.pc_claimed_by_user <> p_user_id THEN
      IF g.id IS NOT NULL THEN r := g; ELSE RAISE EXCEPTION 'Code already claimed'; END IF;
    ELSE
      r := u;
    END IF;
  ELSIF g.id IS NOT NULL THEN
    r := g;
  ELSE
    RAISE EXCEPTION 'Code not found';
  END IF;

  -- status/window
  IF r.status <> 'active' THEN RAISE EXCEPTION 'Promotion not active'; END IF;
  IF NOT (now_ts BETWEEN r.start_at AND r.end_at) THEN RAISE EXCEPTION 'Promotion not in valid window'; END IF;

  -- caps: redeemed only; enforce only when > 0
  SELECT COUNT(*)::int INTO global_count
  FROM user_promotions
  WHERE promo_id = r.id
    AND status   = 'redeemed';
  IF r.max_global_redemptions IS NOT NULL AND r.max_global_redemptions > 0
     AND global_count >= r.max_global_redemptions THEN
    RAISE EXCEPTION 'Global redemption limit reached';
  END IF;

  SELECT COUNT(*)::int INTO user_count
  FROM user_promotions
  WHERE promo_id = r.id
    AND user_id  = p_user_id
    AND status   = 'redeemed';
  IF r.max_per_user IS NOT NULL AND r.max_per_user > 0
     AND user_count >= r.max_per_user THEN
    RAISE EXCEPTION 'Already used this promotion';
  END IF;

  -- if we landed on a unique code and it's admin-blocked, stop
  IF r.pc_id IS NOT NULL AND r.pc_is_blocked THEN
    RAISE EXCEPTION 'Code blocked';
  END IF;

  -- write redemption
  v_expires_at := now_ts + (r.days_valid || ' days')::interval;

  INSERT INTO user_promotions (user_id, promo_id, code_used, assigned_at, expires_at, status, redeemed_at, points_awarded)
  VALUES (p_user_id, r.id, v_code, now_ts, v_expires_at, 'redeemed', now_ts, r.points)
  RETURNING id INTO v_user_promo_id;

  -- mark unique code as claimed by this user
  IF r.pc_id IS NOT NULL THEN
    UPDATE promo_codes
       SET claimed_by_user = p_user_id, claimed_at = now_ts
     WHERE id = r.pc_id;
  END IF;

  INSERT INTO points_ledger (user_id, delta, source, source_id, description)
  VALUES (p_user_id, r.points, 'promo', v_user_promo_id, 'Promo ' || v_code || ' redeemed');

  RETURN jsonb_build_object(
    'ok', true,
    'message', 'Promo applied',
    'promo', jsonb_build_object(
      'code', v_code,
      'name', r.name,
      'planLabel', r.description,
      'days', r.days_valid,
      'points', r.points,
      'expiresAt', v_expires_at
    )
  );
END;
$$;

-- =========================================
-- Admin helpers (unchanged)
-- =========================================
CREATE OR REPLACE FUNCTION promo_suspend(p_promo_id uuid)
RETURNS void LANGUAGE sql AS $$
  UPDATE promotions SET status='suspended', updated_at=NOW() WHERE id=$1;
$$;

CREATE OR REPLACE FUNCTION promo_block_code(p_code text)
RETURNS void LANGUAGE sql AS $$
  UPDATE promo_codes SET is_blocked = TRUE WHERE code = util_upper_trim($1);
$$;
