// Local-only synthetic acceptance sample. No database, network or private Excel.
import {mkdirSync,writeFileSync} from 'node:fs';
import {resolve,join} from 'node:path';
import {randomUUID,createHash} from 'node:crypto';
import assert from 'node:assert/strict';
import ExcelJS from 'exceljs';
import JSZip from 'jszip';
import sharp from 'sharp';
import {exportQuotation,quotationExportMetadata} from '../src/lib/quotation-export';
import {defaultProcurementTemplate} from '../src/lib/procurement-template';
import {emptyFields,type Product,type Project} from '../src/lib/types';

async function main(){
  const destination=resolve(process.argv[2] || '.data/outputs/product-record-20261024');
  mkdirSync(destination,{recursive:true,mode:0o700});
  const project:Project={id:randomUUID(),name:'合成看货示例',market:'示例市场',date:'2026-10-24',demo:true,createdAt:'2026-10-24T01:00:00Z'};
  const images=new Map<string,Buffer>();
  const colors=['#739c8b','#d8ba75','#b98787','#728daf','#aba1c5','#91bdb5'];
  async function product(name:string,supplier:string,patch:Partial<Product>,count:number):Promise<Product>{
    const id=randomUUID(),photos=[];
    for(let index=0;index<count;index++){
      const photoId=randomUUID(),svg=Buffer.from(`<svg width="1400" height="1100" xmlns="http://www.w3.org/2000/svg"><rect width="1400" height="1100" fill="#f4f1e8"/><rect x="220" y="180" width="850" height="650" rx="100" fill="${colors[index]}"/><circle cx="650" cy="475" r="180" fill="#ffffff" opacity=".35"/><text x="100" y="1010" font-size="100" font-family="sans-serif" fill="#263b32">DEMO PHOTO ${index+1}</text></svg>`);
      images.set(photoId,await sharp(svg).png().toBuffer());
      photos.push({id:photoId,url:'',name:'合成商品图-'+(index+1)+'.png'});
    }
    return{...emptyFields,id,projectId:project.id,version:1,name,supplier,photos,createdAt:'2026-10-24T01:00:00Z',updatedAt:'2026-10-24T01:00:00Z',...patch};
  }
  const products=[
    await product('陶瓷杯','示例商户甲',{sku:'DEMO-A01',colors:'白色',material:'陶瓷',cartons:2,cartonQty:12,unitPrice:6.8,cartonCbm:.06,barcode:'0000123456789',exportRemarks:'纸盒包装；数量由箱数计算',notes:'内部待问标签',confirmed:true},2),
    await product('陶瓷杯（再次记录）','示例商户甲',{sku:'DEMO-A01',unitPrice:7,quantity:0,exportRemarks:'同款另一次记录；填写数量 0 优先',confirmed:false},1),
    await product('待询价收纳盒','示例商户乙',{sku:'DEMO-B01',cartons:3,cartonQty:null,unitPrice:null,cartonCbm:null,exportRemarks:'报价、每箱数量和体积未知，留空'},0),
    await product('彩色笔套装','示例商户乙',{sku:'DEMO-B02',colors:'六色',cartons:1,cartonQty:24,quantity:18,unitPrice:1.25,currency:'USD',cartonCbm:.024,exportRemarks:'手填 18 件优先，不自动使用每箱 24 件',evaluation:'内部比较意见',confirmed:true},6),
  ];
  const sourceHash=()=>createHash('sha256').update(JSON.stringify(products)).update(Buffer.concat([...images.values()])).digest('hex');
  const before=sourceHash(),template=defaultProcurementTemplate();
  template.company='合成示例公司';template.companyEnglish='SYNTHETIC PRODUCT RECORD';
  template.packingRequirements='此文件只演示商品记录与整理，不代表订单。包装要求原文保留。';
  const output:Record<string,unknown>[]=[];
  for(const [name,options]of [
    ['商品记录-带全部图片.xlsx',{images:true}],
    ['商品记录-纯数据.xlsx',{images:false}],
    ['商品记录-仅已核对.xlsx',{images:false,scope:'confirmed' as const}],
  ] as const){
    const selected=options.scope==='confirmed'?products.filter(p=>p.confirmed):products;
    const bytes=await exportQuotation(project,products,id=>images.get(id) || null,template,options);
    const zip=await JSZip.loadAsync(bytes,{checkCRC32:true}),book=new ExcelJS.Workbook();
    await book.xlsx.load(bytes as unknown as ExcelJS.Buffer);
    const metadata=quotationExportMetadata(template,options,selected.map(p=>p.currency),selected);
    const header=metadata.headerRows.filter(row=>row.enabled).length+1;
    const keys=metadata.columns.map(c=>c.key),column=(key:string)=>keys.indexOf(key)+1;
    let rows=0,photos=0;
    for(const sheet of book.worksheets.filter(s=>s.name!=='说明')){
      photos+=sheet.getImages().length;
      const expected=selected.filter(p=>p.supplier===sheet.name);
      assert.deepEqual((sheet.getRow(header).values as string[]).slice(1),metadata.columns.map(c=>c.label));
      expected.forEach((product,index)=>{
        const row=sheet.getRow(header+index+1),quantity=product.quantity??(product.cartons!=null && product.cartonQty!=null?product.cartons*product.cartonQty:null);
        assert.equal(row.getCell(column('sku')).value,product.sku);
        assert.equal(row.getCell(column('barcode')).text,product.barcode);
        const actual=(key:string)=>{const c=row.getCell(column(key));return c.formula?c.result ?? null:c.value;};
        assert.equal(actual('quantity'),quantity);
        assert.equal(actual('amount'),quantity!=null && product.unitPrice!=null?quantity*product.unitPrice:null);
        assert.equal(actual('cbm'),product.cartons!=null && product.cartonCbm!=null?product.cartons*product.cartonCbm:null);
        rows++;
      });
    }
    assert.equal(rows,selected.length);assert.equal(photos,options.images?selected.reduce((sum,p)=>sum+p.photos.length,0):0);
    const first=book.getWorksheet('示例商户甲')!;
    assert.equal(first.getCell(header+1,column('quantity')).formula,'IF(COUNT(B7,C7)=2,B7*C7,"")');
    if(options.scope!=='confirmed'){
      assert.equal(first.getCell(header+2,column('quantity')).value,0);
      assert.equal(first.getCell(header+2,column('amount')).result,0);
    }
    assert.ok(zip.file('xl/workbook.xml'));
    writeFileSync(join(destination,name),bytes,{mode:0o600});
    output.push({file:name,bytes:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex'),products:rows,photos,worksheets:book.worksheets.length,counts:metadata.counts,zipCRC:true,formulaCaches:true});
  }
  assert.equal(sourceHash(),before,'original product and photo data unchanged');
  const report={date:'2026-10-24',synthetic:true,network:false,database:false,sourceUnchanged:true,desktopOpenVerified:false,phoneVerified:false,output};
  writeFileSync(join(destination,'validation.json'),JSON.stringify(report,null,2)+'\n',{mode:0o600});
  console.log(JSON.stringify({destination,...report},null,2));
}
main().catch(error=>{console.error(error);process.exitCode=1;});
