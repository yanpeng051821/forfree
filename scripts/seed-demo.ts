import { createHash } from 'node:crypto';
import { readFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { createProject, db, getProduct, listProducts, readPhoto, saveProduct, stagePhoto } from '../src/lib/db';
import { dataDir } from '../src/lib/storage';
import { emptyFields, type ProductFields } from '../src/lib/types';

function key(value: string) {
  const hex = createHash('sha256').update('forfree.demo.20261016.v1:' + value).digest('hex');
  return `${hex.slice(0,8)}-${hex.slice(8,12)}-4${hex.slice(13,16)}-a${hex.slice(17,20)}-${hex.slice(20,32)}`;
}
const assets = join(__dirname, 'demo-assets');
type Sample = Partial<ProductFields> & { name: string; images: string[]; hour?: number };
const cup: Partial<ProductFields> = { supplier: '博艺陶瓷（演示）· 二区102', supplierContact: '演示联系人 · 请勿联系', material: '陶瓷', colors: '米白色', dimensions: '高11 × 口径9 cm', weightG: 310, cartonQty: 24, cartonDimensions: '40 × 30 × 35 cm', cartonCbm: 0.042, leadTimeDays: 18, tradeTerms: '含税出厂价', moq: 100 };
const grey: Partial<ProductFields> = { ...cup, supplier: '盛泰陶瓷（演示）· 二区208', colors: '灰色', weightG: 280, cartonQty: 36, cartonCbm: 0.072, leadTimeDays: 30, moq: 500 };
const basket: Partial<ProductFields> = { supplier: '恒源家居（演示）· 一区3045', supplierContact: '演示微信 · 不是真实账号', material: '棉麻 + 铁线骨架', colors: '原色', dimensions: '32 × 24 × 20 cm', cartonQty: 12, tradeTerms: '出厂价' };
export function seedDemo(owner: string) {
  if (!/^[a-f0-9-]{36}$/.test(owner) || !db().prepare('SELECT id FROM users WHERE id=?').get(owner)) throw new Error('请指定已登录账号的 owner ID');
  const groups: { name: string; date: string; market: string; products: Sample[] }[] = [
    { name: '餐厨选品 · 中东客户', date: '2026-10-16', market: '国际商贸城二区', products: [
      { ...cup, name: '双耳粗陶马克杯', sku: 'BY-M09', unitPrice: 12.5, confirmed: true, favorite: true, rating: 5, evaluation: '质感好，100件可试单；适合客户的自然风系列。', description: '品名：双耳粗陶马克杯，材质：陶瓷，米白色，单价12.50元，100个起订，单个310克，每箱24个，大货交期：18天。', notes: '演示记录。混色200件起；印标加0.80元，需客户确认。', images: ['cup-a','glaze','carton'], hour: 14 },
      { ...grey, name: '手捏水洗陶杯', sku: 'ST-C21', unitPrice: 11.2, favorite: true, rating: 4, evaluation: '价格稍低，起订量较高；交期需再确认。', description: '灰色水洗陶杯，单价11.20元，500件起订，每箱36件，大货交期：30天。', notes: '演示记录。普通蛋格包装，需再问破损处理。', images: ['cup-b','glaze'], hour: 13 },
      { ...cup, name: '粗陶杯 · 礼盒方案', sku: 'BY-G02', unitPrice: 14.8, moq: 200, confirmed: true, rating: 3, evaluation: '礼盒增加单价，适合节日款；先看客户预算。', description: '陶瓷杯礼盒装，报价14.80元，起订200件。', notes: '演示记录。礼盒设计未确认。', images: ['cup-a','carton'], hour: 11 },
      { ...grey, name: '哑光陶杯 · 定制款', sku: 'ST-OEM', unitPrice: null, leadTimeDays: null, rating: 2, evaluation: '定制报价未收到，先留作备选。', description: '定制底标和颜色，报价、生产交期等商家回复。', notes: '演示记录。待问版费与混色门槛。', images: ['cup-b'], hour: 10 },
    ] },
    { name: '家居收纳 · 秋季备选', date: '2026-10-16', market: '国际商贸城一区', products: [
      { ...basket, name: '棉麻编织收纳篮', sku: 'HY-B32', unitPrice: null, moq: null, favorite: true, rating: 4, evaluation: '外观适合自然风客户，待阶梯报价。', description: '品名：棉麻编织收纳篮，材质：棉麻和铁线，颜色：原色，每箱12个。大中小尺寸价格不同，尚未报价。', notes: '演示记录。要报价单和带提手版本照片。', images: ['basket'], hour: 16 },
      { ...basket, name: '收纳篮 · 三件套', sku: 'HY-SET3', unitPrice: 42, moq: 120, confirmed: true, rating: 4, cartonQty: 6, evaluation: '嵌套装箱节省空间，套装价待客户比较。', description: '三件套报价42元，120套起订，每箱6套。', notes: '演示记录。尺寸待补，重量保持空白。', images: ['basket','carton'], hour: 15 },
    ] },
    { name: '餐厨复看 · 欧洲客户', date: '2026-10-15', market: '国际商贸城二区', products: [
      { ...cup, name: '粗陶杯 · 欧元报价', sku: 'EU-C09', unitPrice: 2.1, currency: 'EUR', tradeTerms: 'FOB 宁波', moq: 600, confirmed: true, favorite: true, rating: 5, evaluation: '外观符合客户要求，需要核对FOB费用口径。', description: '陶瓷杯，单价2.10欧元，600件起订，报价条款：FOB 宁波。', notes: '演示记录。跨币种不能直接比较单价。', images: ['cup-a','carton'], hour: 15 },
      { ...grey, name: '水洗杯 · 美元报价', sku: 'US-C21', unitPrice: 1.8, currency: 'USD', tradeTerms: 'FOB 宁波', confirmed: true, rating: 4, evaluation: '款式较稳，客户偏好更浅的颜色。', description: '陶瓷杯，报价1.80美元，500个起订，单个280克。', notes: '演示记录。需要浅灰色样。', images: ['cup-b'], hour: 13 },
      { ...basket, name: '棉麻篮 · 昨日询价', sku: 'HY-Q10', unitPrice: null, favorite: false, rating: null, description: '棉麻篮，小批量试单，价格尚未回复。', notes: '演示记录。联系商家核实MOQ。', images: ['basket'], hour: 11 },
    ] },
    { name: '首轮看样 · 家居', date: '2026-10-14', market: '国际商贸城一区 / 二区', products: [
      { ...cup, name: '粗陶杯 · 首轮样品', sku: 'SAMPLE-A', unitPrice: 13, moq: 100, favorite: true, rating: 4, evaluation: '第一轮手感较好，建议复看釉面一致性。', description: '陶瓷杯样品，13元一个，100个起订。', notes: '演示记录。样品与大货一致性待确认。', images: ['cup-a','glaze'], hour: 15 },
      { ...grey, name: '水洗杯 · 首轮样品', sku: 'SAMPLE-B', unitPrice: 12, moq: 300, confirmed: true, rating: 3, evaluation: '釉色有差异，可再问更稳定的批次。', description: '灰色陶瓷杯，报价12元，300件起订。', notes: '演示记录。询问批次色差标准。', images: ['cup-b'], hour: 12 },
      { ...basket, name: '编织篮 · 陈列样品', sku: 'SAMPLE-C', unitPrice: 18, moq: 150, rating: 4, evaluation: '陈列效果好，提手的强度要核对。', description: '收纳篮，报价18元，150件起订，每箱12件。', notes: '演示记录。确认内衬是否包含。', images: ['basket'], hour: 10 },
    ] },
  ];
  const result: { projects: { id: string; name: string; date: string }[]; productIds: string[]; draft: { demo: boolean; projectId: string; fields: ProductFields; photos: { id: string; name: string; path: string; persistent: boolean }[] } } = { projects: [], productIds: [], draft: { demo: true, projectId: '', fields: { ...emptyFields }, photos: [] } };
  for (const [groupIndex, group] of groups.entries()) {
    const project = createProject(owner, { name: group.name, market: group.market, date: group.date }, key(owner + ':project:' + groupIndex));
    db().prepare('UPDATE projects SET demo=1 WHERE id=? AND owner_id=?').run(project.id, owner);
    result.projects.push({ id: project.id, name: project.name, date: group.date });
    const existing = listProducts(owner, project.id);
    for (const [index, sample] of group.products.entries()) {
      const { images, hour = 12, ...fields } = sample;
      let record = existing.find(item => item.sku === fields.sku);
      if (!record) {
        const photoIds = images.map(name => stagePhoto(owner, { name: name + '（设计参考演示）.jpg', bytes: readFileSync(join(assets, name + '.jpg')) }).id);
        record = saveProduct(owner, { requestKey: key(owner + ':product:' + groupIndex + ':' + index), projectId: project.id, fields: { ...emptyFields, ...fields }, photoIds });
        const timestamp = `${group.date}T${String(hour - 8).padStart(2, '0')}:10:00.000Z`;
        db().prepare('UPDATE products SET created_at=?,updated_at=? WHERE id=?').run(timestamp, timestamp, record.id);
      }
      result.productIds.push(record.id);
    }
  }
  const source = getProduct(owner, result.productIds[0]);
  const draftPhotoName = '演示草稿（独立照片）.jpg';
  const existingDraftPhoto = db().prepare('SELECT id FROM media WHERE owner_id=? AND product_id IS NULL AND name=? AND expires_at>? LIMIT 1').get(owner, draftPhotoName, Date.now()) as { id: string } | undefined;
  const draftPhoto = existingDraftPhoto || stagePhoto(owner, { name: draftPhotoName, bytes: readPhoto(owner, source.photos[0].id) });
  result.draft = { demo: true, projectId: result.projects[0].id, fields: { ...emptyFields, name: '粗陶杯 · 待补样品（演示草稿）', supplier: cup.supplier || '', supplierContact: cup.supplierContact || '', description: '演示草稿：刚拍了照片，报价和箱规还没补。', notes: '此条未正式保存，不会导出。' }, photos: [{ id: draftPhoto.id, name: draftPhotoName, path: '', persistent: false }] };
  return result;
}
if (require.main === module) {
  if (process.env.NODE_ENV === 'production') throw new Error('演示播种工具仅用于本机开发数据');
  const owner = process.argv[2];
  if (!owner) throw new Error('用法：npm run seed:demo -- 已登录账号的ownerID');
  const backupDirectory = join(dataDir(), 'backups'); mkdirSync(backupDirectory, { recursive: true });
  const backup = join(backupDirectory, 'before-demo-' + Date.now() + '.sqlite');
  db().prepare('VACUUM INTO ?').run(backup);
  console.log(JSON.stringify({ ...seedDemo(owner), backup }, null, 2));
}
