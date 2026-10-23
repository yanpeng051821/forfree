const test=require('node:test');
const assert=require('node:assert/strict');
const capture=require('../miniprogram/utils/capture-template');
const domain=require('../miniprogram/utils/domain');
test('known procurement inputs calculate totals without MOQ, unknowns remain blank and zero is valid',()=>{
 assert.deepEqual(capture.totals({...domain.emptyFields,moq:100,unitPrice:12,cartonQty:24}),{derivedQuantity:null,amount:'',cbm:null,quantityMismatch:false});
 assert.deepEqual(capture.totals({...domain.emptyFields,cartons:2,cartonQty:24,unitPrice:12,cartonCbm:.04}),{derivedQuantity:48,amount:'576.00',cbm:.08,quantityMismatch:false});
 assert.equal(capture.totals({...domain.emptyFields,quantity:0,unitPrice:12}).amount,'0.00');
 assert.equal(capture.totals({...domain.emptyFields,quantity:50,cartons:2,cartonQty:24}).quantityMismatch,true);
});
test('custom column definitions follow company order; retired values remain in saved fields',()=>{
 const fields=domain.fieldsFrom({...domain.emptyFields,custom:{retired:'keep',client_ref:'00012'}});
 const schema=capture.columns({columns:[{key:'description',label:'备注',enabled:true},{key:'sku',label:'REF.',enabled:true}],customFields:[{key:'client_ref',label:'客户编号'},{key:'packing',label:'标签要求'}]});
 assert.deepEqual(capture.customValues(schema.custom,fields),[{key:'client_ref',label:'客户编号',value:'00012'},{key:'packing',label:'标签要求',value:''}]);
 assert.equal(schema.labels.exportRemarks,'备注');assert.equal(domain.validateFields({...fields,name:'cup'}).custom.retired,'keep');
});
test('custom three-way merge preserves independent edits and shows conflicts per column',()=>{
 const result=capture.mergeCustom({a:'local',b:'old',c:'both'},{a:'old',b:'remote',c:'conflict'},{a:'old',b:'old',c:'base'},[{key:'c',label:'客户字段'}]);
 assert.deepEqual(result.fields,{a:'local',b:'remote',c:'both'});assert.deepEqual(result.conflicts,[{key:'custom:c',label:'客户字段',local:'both',remote:'conflict'}]);
});
test('AI merges only explicit quantity/cartons and leaves custom values, personal notes and zero values intact',()=>{
 const fields={...domain.emptyFields,quantity:0,custom:{packing:'manual'},notes:'private'};
 const result=domain.mergeExtraction(fields,{quantity:48,cartons:2,cartonQty:24,barcode:'000012',exportRemarks:'客户标签',custom:{packing:'invented'}});
 assert.equal(result.fields.quantity,0);assert.equal(result.fields.cartons,2);assert.equal(result.fields.cartonQty,24);assert.equal(result.fields.barcode,'000012');assert.equal(result.fields.exportRemarks,'客户标签');assert.equal(result.fields.notes,'private');assert.equal(result.fields.custom.packing,'manual');
 assert.throws(()=>domain.validateFields({...domain.emptyFields,name:'cup',quantity:1.5}));
});
