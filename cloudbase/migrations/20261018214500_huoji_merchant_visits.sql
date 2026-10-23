BEGIN;
SELECT pg_advisory_xact_lock(hashtext('huoji-merchant-visits-20261018'));
ALTER TABLE public.huoji_projects ADD COLUMN IF NOT EXISTS supplier text;
ALTER TABLE public.huoji_projects ADD COLUMN IF NOT EXISTS supplier_contact text;
CREATE OR REPLACE FUNCTION public.huoji_project(p_owner text,p_id text,p_summary bool DEFAULT false)
RETURNS jsonb LANGUAGE sql STABLE SET search_path=pg_catalog AS $fn$
 SELECT jsonb_build_object('id',p.id,'name',p.name,'market',p.market,'date',p.date,'demo',p.demo,'createdAt',p.created_at,'supplier',p.supplier,'supplierContact',p.supplier_contact)
 || CASE WHEN p_summary THEN jsonb_build_object('summary',public.huoji_summary(p_owner,p.id)) ELSE '{}'::jsonb END
 FROM public.huoji_projects p WHERE p.owner_id=p_owner AND p.id=p_id;
$fn$;
DO $repair$
DECLARE definition text;
BEGIN
 definition:=pg_get_functiondef('public.huoji_command_core_20261018(text,text,text,jsonb)'::regprocedure);
 IF position('WHEN ''merchant/visits'' THEN' in definition)>0 THEN RETURN; END IF;
 definition:=replace(definition,'INSERT INTO public.huoji_projects(owner_id,name,market,date) VALUES(p_owner,p_payload->>''name'',COALESCE(p_payload->>''market'',''''),day_value)',
 'IF (p_payload ? ''supplier'' AND (jsonb_typeof(p_payload->''supplier'')<>''string'' OR length(p_payload->>''supplier'')>200)) OR (p_payload ? ''supplierContact'' AND (jsonb_typeof(p_payload->''supplierContact'')<>''string'' OR length(p_payload->>''supplierContact'')>200)) THEN PERFORM public.huoji_fail(''VALIDATION'',''商家资料无效''); END IF; INSERT INTO public.huoji_projects(owner_id,name,market,date,supplier,supplier_contact) VALUES(p_owner,p_payload->>''name'',COALESCE(p_payload->>''market'',''''),day_value,p_payload->>''supplier'',p_payload->>''supplierContact'')');
 definition:=replace(definition,'WHEN ''product/get'' THEN',$branch$
 WHEN 'merchant/visits' THEN
  day_value:=(p_payload->>'date')::date;
  IF day_value IS NULL THEN PERFORM public.huoji_fail('VALIDATION','请选择看货日期'); END IF;
  SELECT COALESCE(jsonb_agg(g.info ORDER BY g.latest DESC,g.project_id DESC,g.supplier),'[]'::jsonb) INTO result FROM (
   SELECT p.id project_id,COALESCE(goods.fields->>'supplier',p.supplier,'') supplier,MAX(COALESCE(goods.created_at,p.created_at)) latest,
    jsonb_build_object('projectId',p.id,'date',day_value,'market',p.market,'demo',p.demo,'supplier',COALESCE(goods.fields->>'supplier',p.supplier,''),
     'supplierContact',COALESCE((array_agg(goods.fields->>'supplierContact' ORDER BY goods.created_at DESC,goods.id DESC) FILTER(WHERE COALESCE(goods.fields->>'supplierContact','')<>''))[1],p.supplier_contact,''),
     'total',count(goods.id),'confirmed',count(goods.id) FILTER(WHERE goods.fields->'confirmed'='true'::jsonb),'pending',count(goods.id) FILTER(WHERE goods.fields->'confirmed' IS DISTINCT FROM 'true'::jsonb),'missingPrice',count(goods.id) FILTER(WHERE goods.fields->>'unitPrice' IS NULL)) info
   FROM public.huoji_projects p LEFT JOIN public.huoji_products goods ON goods.owner_id=p.owner_id AND goods.project_id=p.id AND goods.deleted_at IS NULL
    AND goods.created_at >= (day_value::timestamp AT TIME ZONE 'Asia/Shanghai') AND goods.created_at < ((day_value+1)::timestamp AT TIME ZONE 'Asia/Shanghai')
   WHERE p.owner_id=p_owner AND (goods.id IS NOT NULL OR (p.date=day_value AND p.supplier IS NOT NULL))
   GROUP BY p.id,COALESCE(goods.fields->>'supplier',p.supplier,'')
  ) g;
 WHEN 'product/get' THEN
$branch$);
 IF position('WHEN ''merchant/visits'' THEN' in definition)=0 OR position('market,date,supplier,supplier_contact' in definition)=0 THEN RAISE EXCEPTION 'Unrecognized merchant visits implementation'; END IF;
 EXECUTE definition;
END $repair$;
COMMIT;
