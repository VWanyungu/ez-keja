import type { Knex } from 'knex';

// Cross-table rules enforced in the database (design §7.2): T3, T5, T6, T7, T8, plus an evidence
// guard that is part of T3's "no changes after the decision" rule. T1 and T2 are attached to
// their tables in the table migrations. All functions are SECURITY INVOKER (design §10.2).

const FN = 'LANGUAGE plpgsql SET search_path = public, pg_temp';
// Function-level SET: PostgreSQL reverts it when the function exits, so the T7 window is only
// the body of the functions that carry it (T3, T6).
const WRITER = "SET khunt.verification_writer = 'on'";

export async function up(knex: Knex): Promise<void> {
  // ---- T7: verification_status can only be written by T3 / T6 -------------------------------
  await knex.raw(`
    CREATE FUNCTION guard_verification_columns() RETURNS trigger ${FN} AS $$
    BEGIN
      IF TG_OP = 'INSERT' THEN
        IF NEW.verification_status <> 'unverified' THEN
          RAISE EXCEPTION 'verification_status must start as unverified' USING ERRCODE = 'check_violation';
        END IF;
      ELSIF NEW.verification_status IS DISTINCT FROM OLD.verification_status
            AND coalesce(current_setting('khunt.verification_writer', true), '') <> 'on' THEN
        RAISE EXCEPTION 'verification_status is set only by an Admin decision on a verification case'
          USING ERRCODE = 'restrict_violation';
      END IF;
      RETURN NEW;
    END $$`);
  for (const table of ['profiles', 'buildings']) {
    await knex.raw(
      `CREATE TRIGGER ?? BEFORE INSERT OR UPDATE ON ?? FOR EACH ROW EXECUTE FUNCTION guard_verification_columns()`,
      [`trg_${table}_guard_verification`, table],
    );
  }

  // ---- T3: guard transitions and keep the status caches in step with the newest case -------
  await knex.raw(`
    CREATE FUNCTION sync_verification_status() RETURNS trigger ${FN} ${WRITER} AS $$
    DECLARE
      newest verification_cases%ROWTYPE;
      cache text;
    BEGIN
      IF TG_WHEN = 'BEFORE' THEN
        IF TG_OP = 'INSERT' THEN
          IF NEW.status <> 'pending' THEN
            RAISE EXCEPTION 'a verification case must be inserted as pending' USING ERRCODE = 'check_violation';
          END IF;
          RETURN NEW;
        END IF;

        IF NEW.subject_type IS DISTINCT FROM OLD.subject_type
           OR NEW.subject_user_id IS DISTINCT FROM OLD.subject_user_id
           OR NEW.subject_building_id IS DISTINCT FROM OLD.subject_building_id
           OR NEW.submitted_by IS DISTINCT FROM OLD.submitted_by
           OR NEW.submitted_at IS DISTINCT FROM OLD.submitted_at
           OR NEW.origin IS DISTINCT FROM OLD.origin THEN
          RAISE EXCEPTION 'subject, submitter and origin of a verification case cannot change'
            USING ERRCODE = 'restrict_violation';
        END IF;

        IF NEW.status IS DISTINCT FROM OLD.status THEN
          IF NOT ((OLD.status = 'pending' AND NEW.status IN ('approved', 'rejected'))
               OR (OLD.status = 'approved' AND NEW.status IN ('revoked', 'superseded'))) THEN
            RAISE EXCEPTION 'verification case cannot move from % to %', OLD.status, NEW.status
              USING ERRCODE = 'check_violation';
          END IF;
          IF EXISTS (SELECT 1 FROM verification_cases c
                     WHERE c.id <> NEW.id
                       AND c.subject_type = NEW.subject_type
                       AND c.subject_user_id IS NOT DISTINCT FROM NEW.subject_user_id
                       AND c.subject_building_id IS NOT DISTINCT FROM NEW.subject_building_id
                       AND (c.submitted_at, c.id) > (NEW.submitted_at, NEW.id)) THEN
            RAISE EXCEPTION 'only the newest verification case of a subject can change status'
              USING ERRCODE = 'check_violation';
          END IF;
        END IF;
        RETURN NEW;
      END IF;

      SELECT * INTO newest FROM verification_cases c
      WHERE c.subject_type = NEW.subject_type
        AND c.subject_user_id IS NOT DISTINCT FROM NEW.subject_user_id
        AND c.subject_building_id IS NOT DISTINCT FROM NEW.subject_building_id
      ORDER BY c.submitted_at DESC, c.id DESC LIMIT 1;

      cache := CASE newest.status
        WHEN 'pending' THEN 'pending' WHEN 'approved' THEN 'verified'
        WHEN 'rejected' THEN 'rejected' WHEN 'revoked' THEN 'revoked'
      END; -- superseded: leave the cache; the pending case inserted next sets it
      IF cache IS NULL THEN RETURN NULL; END IF;

      IF NEW.subject_type = 'account' THEN
        UPDATE profiles SET verification_status = cache
        WHERE user_id = NEW.subject_user_id AND verification_status IS DISTINCT FROM cache;
      ELSE
        UPDATE buildings SET verification_status = cache
        WHERE id = NEW.subject_building_id AND verification_status IS DISTINCT FROM cache;
      END IF;
      RETURN NULL;
    END $$`);
  await knex.raw(`CREATE TRIGGER trg_vc_guard BEFORE INSERT OR UPDATE ON verification_cases
                  FOR EACH ROW EXECUTE FUNCTION sync_verification_status()`);
  await knex.raw(`CREATE TRIGGER trg_vc_sync AFTER INSERT OR UPDATE OF status ON verification_cases
                  FOR EACH ROW EXECUTE FUNCTION sync_verification_status()`);

  // Evidence is frozen once the case is decided.
  await knex.raw(`
    CREATE FUNCTION guard_verification_evidence() RETURNS trigger ${FN} AS $$
    DECLARE case_status text;
    BEGIN
      IF TG_OP = 'UPDATE' AND NEW.case_id <> OLD.case_id THEN
        RAISE EXCEPTION 'evidence cannot move between cases' USING ERRCODE = 'restrict_violation';
      END IF;
      SELECT status INTO case_status FROM verification_cases
      WHERE id = CASE WHEN TG_OP = 'DELETE' THEN OLD.case_id ELSE NEW.case_id END;
      IF case_status IS DISTINCT FROM 'pending' THEN
        RAISE EXCEPTION 'evidence can change only while the verification case is pending'
          USING ERRCODE = 'restrict_violation';
      END IF;
      RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
    END $$`);
  await knex.raw(`CREATE TRIGGER trg_ve_guard BEFORE INSERT OR UPDATE OR DELETE ON verification_evidence
                  FOR EACH ROW EXECUTE FUNCTION guard_verification_evidence()`);

  // ---- T6: a verified building that moves is re-verified -----------------------------------
  await knex.raw(`
    CREATE FUNCTION reverify_on_material_change() RETURNS trigger ${FN} ${WRITER} AS $$
    BEGIN
      UPDATE verification_cases SET status = 'superseded'
      WHERE subject_type = 'building' AND subject_building_id = NEW.id AND status = 'approved';
      -- clock_timestamp(): must sort after the case just superseded, even in the same transaction.
      INSERT INTO verification_cases (subject_type, subject_building_id, origin, status, submitted_at)
      VALUES ('building', NEW.id, 'material_change', 'pending', clock_timestamp());
      RETURN NULL;
    END $$`);
  await knex.raw(`
    CREATE TRIGGER trg_buildings_reverify AFTER UPDATE OF area_id, latitude, longitude ON buildings
    FOR EACH ROW WHEN (NEW.verification_status = 'verified'
      AND (OLD.area_id IS DISTINCT FROM NEW.area_id
           OR OLD.latitude IS DISTINCT FROM NEW.latitude
           OR OLD.longitude IS DISTINCT FROM NEW.longitude))
    EXECUTE FUNCTION reverify_on_material_change()`);

  // ---- T8: a published building's contact keeps a phone ------------------------------------
  await knex.raw(`
    CREATE FUNCTION guard_contact_phone() RETURNS trigger ${FN} AS $$
    BEGIN
      IF TG_TABLE_NAME = 'profiles' THEN
        IF EXISTS (SELECT 1 FROM buildings b
                   WHERE b.contact_user_id = NEW.user_id
                     AND (b.status = 'published'
                          OR (b.status = 'suspended' AND b.status_before_suspension = 'published'))) THEN
          RAISE EXCEPTION 'cannot clear the phone of the designated contact of a published building'
            USING ERRCODE = 'check_violation';
        END IF;
      ELSIF NEW.contact_user_id IS NOT NULL
            AND NOT EXISTS (SELECT 1 FROM profiles p WHERE p.user_id = NEW.contact_user_id AND p.phone IS NOT NULL) THEN
        RAISE EXCEPTION 'the designated contact of a published building needs a phone number'
          USING ERRCODE = 'check_violation';
      END IF;
      RETURN NEW;
    END $$`);
  await knex.raw(`CREATE TRIGGER trg_profiles_guard_contact_phone BEFORE UPDATE OF phone ON profiles
                  FOR EACH ROW WHEN (NEW.phone IS NULL) EXECUTE FUNCTION guard_contact_phone()`);
  await knex.raw(`CREATE TRIGGER trg_buildings_guard_contact_phone BEFORE UPDATE OF contact_user_id ON buildings
                  FOR EACH ROW WHEN (NEW.status = 'published') EXECUTE FUNCTION guard_contact_phone()`);

  // ---- T5: publish gate (BR-018, BR-005, FR-VER-008) ---------------------------------------
  // Fails closed: a missing settings key raises instead of defaulting.
  await knex.raw(`
    CREATE FUNCTION setting_int(p_key text) RETURNS integer ${FN} STABLE AS $$
    DECLARE v integer;
    BEGIN
      SELECT value INTO v FROM settings WHERE key = p_key;
      IF NOT FOUND THEN
        RAISE EXCEPTION 'missing required setting %', p_key USING ERRCODE = 'no_data_found';
      END IF;
      RETURN v;
    END $$`);

  // Takes the row (not an id) so the trigger can judge NEW before it is written, e.g. a contact
  // assigned in the same UPDATE that publishes.
  await knex.raw(`
    CREATE FUNCTION building_publish_blockers(b buildings) RETURNS text[] ${FN} STABLE AS $$
    DECLARE
      blockers text[] := '{}';
      min_building integer := setting_int('min_building_photos');
      min_surroundings integer := setting_int('min_surroundings_photos');
      min_space integer := setting_int('min_space_type_photos');
      need_verified integer := setting_int('require_verified_lister_to_publish');
      n integer;
      r record;
    BEGIN
      SELECT count(*) INTO n FROM photos
      WHERE building_id = b.id AND removed_at IS NULL AND category IN ('cover', 'grounds');
      IF n < min_building THEN
        blockers := blockers || format('needs at least %s cover or grounds photos (has %s)', min_building, n);
      END IF;

      IF NOT EXISTS (SELECT 1 FROM photos WHERE building_id = b.id AND removed_at IS NULL AND category = 'cover') THEN
        blockers := blockers || 'needs a cover photo'::text;
      END IF;

      SELECT count(*) INTO n FROM photos
      WHERE building_id = b.id AND removed_at IS NULL AND category = 'surroundings';
      IF n < min_surroundings THEN
        blockers := blockers || format('needs at least %s surroundings photos (has %s)', min_surroundings, n);
      END IF;

      IF b.contact_user_id IS NULL THEN
        blockers := blockers || 'needs a designated contact'::text;
      ELSIF NOT EXISTS (SELECT 1 FROM profiles WHERE user_id = b.contact_user_id AND phone IS NOT NULL) THEN
        blockers := blockers || 'the designated contact has no phone number'::text;
      END IF;

      IF NOT EXISTS (SELECT 1 FROM space_types WHERE building_id = b.id AND removed_at IS NULL) THEN
        blockers := blockers || 'needs at least one space type'::text;
      END IF;
      FOR r IN
        SELECT s.name, (SELECT count(*) FROM photos p WHERE p.space_type_id = s.id AND p.removed_at IS NULL) AS photos
        FROM space_types s WHERE s.building_id = b.id AND s.removed_at IS NULL
      LOOP
        IF r.photos < min_space THEN
          blockers := blockers || format('space type "%s" needs at least %s photos (has %s)', r.name, min_space, r.photos);
        END IF;
      END LOOP;

      IF need_verified = 1 AND NOT EXISTS (
           SELECT 1 FROM profiles WHERE user_id = b.lister_id AND verification_status = 'verified') THEN
        blockers := blockers || 'the lister is not verified'::text;
      END IF;
      RETURN blockers;
    END $$`);
  // For the service layer: SELECT building_publish_blockers(:id) on photo / space-type changes.
  await knex.raw(`
    CREATE FUNCTION building_publish_blockers(p_building_id uuid) RETURNS text[]
    LANGUAGE sql STABLE SET search_path = public, pg_temp AS $$
      SELECT building_publish_blockers(b) FROM buildings b WHERE b.id = p_building_id
    $$`);

  await knex.raw(`
    CREATE FUNCTION enforce_publish_gate() RETURNS trigger ${FN} AS $$
    DECLARE blockers text[] := building_publish_blockers(NEW);
    BEGIN
      IF cardinality(blockers) > 0 THEN
        RAISE EXCEPTION 'Building cannot be published: %', array_to_string(blockers, '; ')
          USING ERRCODE = 'check_violation';
      END IF;
      RETURN NEW;
    END $$`);
  // Any move into 'published': an insert, or an update from another status.
  await knex.raw(`CREATE TRIGGER trg_buildings_publish_gate_insert BEFORE INSERT ON buildings
                  FOR EACH ROW WHEN (NEW.status = 'published') EXECUTE FUNCTION enforce_publish_gate()`);
  await knex.raw(`CREATE TRIGGER trg_buildings_publish_gate_update BEFORE UPDATE OF status ON buildings
                  FOR EACH ROW WHEN (NEW.status = 'published' AND OLD.status IS DISTINCT FROM 'published')
                  EXECUTE FUNCTION enforce_publish_gate()`);
}

export async function down(knex: Knex): Promise<void> {
  const drops = [
    'DROP TRIGGER IF EXISTS trg_buildings_publish_gate_update ON buildings',
    'DROP TRIGGER IF EXISTS trg_buildings_publish_gate_insert ON buildings',
    'DROP TRIGGER IF EXISTS trg_buildings_guard_contact_phone ON buildings',
    'DROP TRIGGER IF EXISTS trg_profiles_guard_contact_phone ON profiles',
    'DROP TRIGGER IF EXISTS trg_buildings_reverify ON buildings',
    'DROP TRIGGER IF EXISTS trg_ve_guard ON verification_evidence',
    'DROP TRIGGER IF EXISTS trg_vc_sync ON verification_cases',
    'DROP TRIGGER IF EXISTS trg_vc_guard ON verification_cases',
    'DROP TRIGGER IF EXISTS trg_buildings_guard_verification ON buildings',
    'DROP TRIGGER IF EXISTS trg_profiles_guard_verification ON profiles',
    'DROP FUNCTION IF EXISTS enforce_publish_gate()',
    'DROP FUNCTION IF EXISTS building_publish_blockers(uuid)',
    'DROP FUNCTION IF EXISTS building_publish_blockers(buildings)',
    'DROP FUNCTION IF EXISTS setting_int(text)',
    'DROP FUNCTION IF EXISTS guard_contact_phone()',
    'DROP FUNCTION IF EXISTS reverify_on_material_change()',
    'DROP FUNCTION IF EXISTS guard_verification_evidence()',
    'DROP FUNCTION IF EXISTS sync_verification_status()',
    'DROP FUNCTION IF EXISTS guard_verification_columns()',
  ];
  for (const sql of drops) await knex.raw(sql);
}
