-- Repair PL/pgSQL variable/table alias collision in staged photo attachment.
-- The row variable m previously shadowed UPDATE alias m under use_variable,
-- causing every owned photo to attach at position zero and raising unique_violation.
BEGIN;
SELECT pg_advisory_xact_lock(hashtext('huoji-photo-attachment-20261018'));
DO $repair$
DECLARE signature regprocedure; definition text; old_fragment text; new_fragment text;
BEGIN
  signature := COALESCE(to_regprocedure('public.huoji_command_core_20261018(text,text,text,jsonb)'),to_regprocedure('public.huoji_command(text,text,text,jsonb)'));
  IF signature IS NULL THEN RAISE EXCEPTION 'Missing prerequisite huoji_command'; END IF;
  definition := pg_get_functiondef(signature);
  old_fragment := 'UPDATE public.huoji_media m SET product_id = id, position = (photo.ordinality - 1)::int, expires_at = NULL';
  new_fragment := 'UPDATE public.huoji_media photo_row SET product_id = command.id, position = (photo.ordinality - 1)::int, expires_at = NULL';
  IF position(old_fragment in definition) > 0 THEN
    definition := replace(definition, old_fragment,new_fragment);
    definition := replace(definition,'WHERE m.owner_id = p_owner AND m.id = photo.photo_id','WHERE photo_row.owner_id = p_owner AND photo_row.id = photo.photo_id');
    EXECUTE definition;
  ELSIF position(new_fragment in definition) = 0 THEN
    RAISE EXCEPTION 'Unrecognized attachment implementation; inspect before applying';
  END IF;
END $repair$;
COMMIT;
