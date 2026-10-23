const mapping = {sku:'sku',cartons:'cartons',pcsPerCarton:'cartonQty',quantity:'quantity',unitPrice:'unitPrice',description:'exportRemarks',barcode:'barcode',cartonCbm:'cartonCbm'};
function columns(template) {
  const labels={}, visible={};
  const compact={sku:'型号 / 货号',cartons:'箱数',cartonQty:'每箱数量',quantity:'采购数量',unitPrice:'单价',exportRemarks:'商品说明 / 对外备注',barcode:'条码',cartonCbm:'单箱体积'};
  (template && template.columns || []).forEach(c=>{if(mapping[c.key]){labels[mapping[c.key]]=c.label.length>12 ? compact[mapping[c.key]]:c.label;visible[mapping[c.key]]=!!c.enabled;}});
  return {labels,visible,custom:(template && template.customFields || []).map(c=>({key:c.key,label:c.label}))};
}
function customValues(definitions,fields){return (definitions||[]).map(c=>({...c,value:fields.custom && fields.custom[c.key] || ''}));}
function number(value){return value!==null && value!==undefined && value!=='' && Number.isFinite(Number(value)) && Number(value)>=0 ? Number(value):null;}
function totals(fields){
  const cartons=number(fields.cartons),pcs=number(fields.cartonQty),price=number(fields.unitPrice),volume=number(fields.cartonCbm),explicit=number(fields.quantity);
  const derived=cartons!==null && pcs!==null ? cartons*pcs:null,quantity=explicit!==null ? explicit:derived;
  return {derivedQuantity:derived,amount:quantity!==null && price!==null ? (quantity*price).toFixed(2):'',cbm:cartons!==null && volume!==null ? Number((cartons*volume).toFixed(6)):null,quantityMismatch:explicit!==null && derived!==null && explicit!==derived};
}
function mergeCustom(local,remote,baseline,definitions){
  const fields=Object.assign({},local),conflicts=[];
  const base=baseline || {};
  [...new Set(Object.keys(local || {}).concat(Object.keys(remote || {})))].forEach(key=>{
    const a=local && local[key],b=remote && remote[key];
    if(a===b)return;
    if(baseline && a===base[key]) {if(b===undefined)delete fields[key];else fields[key]=b;}
    else if(!baseline || b!==base[key])conflicts.push({key:'custom:'+key,label:(definitions || []).find(c=>c.key===key)?.label || key,local:a===undefined?'未填写':a,remote:b===undefined?'未填写':b});
  });
  return {fields,conflicts};
}
module.exports={columns,customValues,totals,mergeCustom};
