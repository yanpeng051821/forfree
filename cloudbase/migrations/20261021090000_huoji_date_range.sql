-- Add range selection to the authenticated existing commands. No records/templates are rewritten.
BEGIN;
SELECT pg_advisory_xact_lock(hashtext('huoji-date-range-20261021'));
CREATE OR REPLACE FUNCTION public.huoji_check_date_range(p_input jsonb)
RETURNS void LANGUAGE plpgsql SET search_path=pg_catalog AS $fn$
DECLARE from_value date; to_value date;
BEGIN
  IF NOT (p_input ?| ARRAY['dateFrom','dateTo']) THEN RETURN; END IF;
  IF NOT (p_input ? 'dateFrom' AND p_input ? 'dateTo') OR p_input ? 'date'
    OR jsonb_typeof(p_input->'dateFrom') IS DISTINCT FROM 'string' OR jsonb_typeof(p_input->'dateTo') IS DISTINCT FROM 'string'
    OR p_input->>'dateFrom' !~ '^\d{4}-\d{2}-\d{2}$' OR p_input->>'dateTo' !~ '^\d{4}-\d{2}-\d{2}$' THEN
    PERFORM public.huoji_fail('VALIDATION','日期范围无效');
  END IF;
  BEGIN
    from_value:=(p_input->>'dateFrom')::date; to_value:=(p_input->>'dateTo')::date;
  EXCEPTION WHEN datetime_field_overflow OR invalid_datetime_format THEN
    PERFORM public.huoji_fail('VALIDATION','日期范围无效');
  END;
  IF to_char(from_value,'YYYY-MM-DD')<>p_input->>'dateFrom' OR to_char(to_value,'YYYY-MM-DD')<>p_input->>'dateTo' OR from_value>to_value THEN
    PERFORM public.huoji_fail('VALIDATION','日期范围无效');
  END IF;
END $fn$;
CREATE OR REPLACE FUNCTION public.huoji_record_date_matches(p_created timestamptz,p_input jsonb)
RETURNS boolean LANGUAGE sql STABLE SET search_path=pg_catalog AS $fn$
 SELECT CASE WHEN p_input ? 'dateFrom' THEN
   p_created >= ((p_input->>'dateFrom')::date::timestamp AT TIME ZONE 'Asia/Shanghai')
   AND p_created < (((p_input->>'dateTo')::date+1)::timestamp AT TIME ZONE 'Asia/Shanghai')
 ELSE NOT (p_input ? 'date') OR (p_input->>'date') IS NULL OR (
   p_created >= ((p_input->>'date')::date::timestamp AT TIME ZONE 'Asia/Shanghai')
   AND p_created < (((p_input->>'date')::date+1)::timestamp AT TIME ZONE 'Asia/Shanghai')) END;
$fn$;
REVOKE ALL ON FUNCTION public.huoji_check_date_range(jsonb),public.huoji_record_date_matches(timestamptz,jsonb) FROM PUBLIC,anon,authenticated,service_role;

DO $core$
DECLARE definition text; previous text; date_pattern text;
BEGIN
 definition:=pg_get_functiondef('public.huoji_command_core_20261018(text,text,text,jsonb)'::regprocedure);
 IF position('WHEN ''capabilities'' THEN' in definition)>0 THEN RETURN; END IF;
 IF position('WHEN ''merchant/list'' THEN' in definition)=0 THEN RAISE EXCEPTION 'Missing merchant scope prerequisite'; END IF;
 previous:=definition;
 definition:=replace(definition,'WHEN ''product/get'' THEN', E'WHEN ''capabilities'' THEN\n result:=jsonb_build_object(''dateRangeExport'',true);\n WHEN ''product/get'' THEN');
 definition:=replace(definition,'project_id := nullif(p_payload->>''projectId'',''''); day_value := (p_payload->>''date'')::date;',
   'PERFORM public.huoji_check_date_range(p_payload); project_id := nullif(p_payload->>''projectId'',''''); day_value := (p_payload->>''date'')::date;');
 definition:=replace(definition,'project_id:=nullif(p_payload->>''projectId'',''''); day_value:=(p_payload->>''date'')::date;',
   'PERFORM public.huoji_check_date_range(p_payload); project_id:=nullif(p_payload->>''projectId'',''''); day_value:=(p_payload->>''date'')::date;');
 definition:=replace(definition,'project_id IS NULL AND day_value IS NULL AND NOT favorite_value THEN',
   'project_id IS NULL AND day_value IS NULL AND NOT (p_payload ? ''dateFrom'') AND NOT favorite_value THEN');
 definition:=replace(definition,'cursor_value := p_payload->>''cursor'';',
   'scope := scope || CASE WHEN p_payload ? ''dateFrom'' THEN '':range:'' || (p_payload->>''dateFrom'') || '':'' || (p_payload->>''dateTo'') ELSE '''' END; cursor_value := p_payload->>''cursor'';');
 -- Covers cursor resolution, base products, page summary and merchant aggregation equally.
 date_pattern:=$pattern$\(day_value IS NULL OR \(p\.created_at >= \(day_value::timestamp AT TIME ZONE 'Asia/Shanghai'\) AND p\.created_at < \(\(day_value\s*\+\s*1\)::timestamp AT TIME ZONE 'Asia/Shanghai'\)\)\)$pattern$;
 definition:=regexp_replace(definition,date_pattern,'public.huoji_record_date_matches(p.created_at,p_payload)','g');
 IF definition=previous OR position('day_value IS NULL OR (p.created_at' in definition)>0
   OR (length(definition)-length(replace(definition,'public.huoji_record_date_matches(p.created_at,p_payload)','')))/length('public.huoji_record_date_matches(p.created_at,p_payload)')<4
   OR (length(definition)-length(replace(definition,'PERFORM public.huoji_check_date_range(p_payload);','')))/length('PERFORM public.huoji_check_date_range(p_payload);')<>2 THEN
   RAISE EXCEPTION 'Unrecognized date-scoped core; no partial range support installed';
 END IF;
 EXECUTE definition;
END $core$;
DO $jobs$
DECLARE definition text;
BEGIN
 definition:=pg_get_functiondef('public.huoji_command(text,text,text,jsonb)'::regprocedure);
 IF position('huoji_check_date_range(input_value)' in definition)>0 THEN RETURN; END IF;
 IF position('ARRAY[''projectId'',''date'',''scope'',''images'',''favorite'',''audience'',''supplier'']' in definition)=0 THEN RAISE EXCEPTION 'Missing export jobs prerequisite'; END IF;
 definition:=replace(definition,'ARRAY[''projectId'',''date'',''scope'',''images'',''favorite'',''audience'',''supplier'']',
   'ARRAY[''projectId'',''date'',''scope'',''images'',''favorite'',''audience'',''supplier'',''dateFrom'',''dateTo'']');
 definition:=replace(definition,'IF input_value ? ''date'' THEN','PERFORM public.huoji_check_date_range(input_value); IF input_value ? ''date'' THEN');
 definition:=replace(definition,'input_value ? ''projectId'' OR input_value ? ''date'' OR COALESCE',
   'input_value ? ''projectId'' OR input_value ? ''date'' OR input_value ? ''dateFrom'' OR COALESCE');
 EXECUTE definition;
END $jobs$;
COMMIT;
