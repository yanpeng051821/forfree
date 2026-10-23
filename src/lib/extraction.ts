import type { Extraction, ProductFields } from "./types";
import { extractionSchema } from "./schema";
import { secureFetch, validateServiceURL } from "./outbound";
import { AppError } from "./errors";

// Conservative text helpers, never inference from a photo or from carton totals.
export function extractText(description: string): Extraction {
  const fields: Partial<ProductFields> = {};
  const text = description.replace(/，|；|。/g, ",");
  const price = text.match(/(?:单价|报价|价格)[：:\s]*(\d+(?:\.\d+)?)\s*(元|美元|美金|欧元)?/) || text.match(/(\d+(?:\.\d+)?)\s*(元|美元|美金|欧元)\s*(?:\/|一|每)?\s*(?:个|件|只|条|套)/);
  if (price) {
    fields.unitPrice = Number(price[1]);
    if (price[2]) fields.currency = /美元|美金/.test(price[2]) ? "USD" : price[2] === "欧元" ? "EUR" : "CNY";
  }
  const moq = text.match(/(\d+)\s*(?:个|件|只|套|条)?\s*起(?:订|批)/) || text.match(/(?:起订量|起订|MOQ)[：:\s]*(\d+)/i);
  if (moq) fields.moq = Number(moq[1]);
  const carton = text.match(/(?:每箱|一箱|装箱数量)[：:\s]*(\d+)\s*(?:个|件|只|套|条)?/);
  if (carton) fields.cartonQty = Number(carton[1]);
  const cartons=text.match(/(?:箱数|采购箱数|CTNS)[：:\s]*(\d+)/i);if(cartons)fields.cartons=Number(cartons[1]);
  const quantity=text.match(/(?:采购数量|购买数量|订购数量|QUANTITY)[：:\s]*(\d+)/i);if(quantity)fields.quantity=Number(quantity[1]);
  const barcode=text.match(/(?:条码|BARCODE)[：:\s]*([^,\n]+)/i);if(barcode)fields.barcode=barcode[1].trim();
  const weight = text.match(/(?:单个|单件|单只|单件重量|单重)(?:重量|重|约|大约)?[：:\s]*(\d+(?:\.\d+)?)\s*(kg|公斤|千克|g|克)/i);
  if (weight) fields.weightG = Number(weight[1]) * (/kg|公斤|千克/i.test(weight[2]) ? 1000 : 1);
  const dimensions = text.match(/(?:^|[,\n\s])(?:商品尺寸|尺寸|大小)[：:\s]*([^,\n]+)/);
  if (dimensions) fields.dimensions = dimensions[1].trim();
  const explicitColors = text.match(/(?:颜色|色号)[：:\s]*([^,\n]+)/);
  const colorMatches = [...text.matchAll(/(米白|乳白|白|红|蓝|绿|黑|黄|粉|紫|灰|银|金|棕|橙|透明)(?:色)/g)].map(m=>m[1] === "透明" ? "透明" : `${m[1]}色`);
  const pairedColors = text.match(/(红白|黑白|蓝白|红蓝)两色/);
  if (explicitColors) fields.colors = explicitColors[1].trim();
  else if (pairedColors) fields.colors = pairedColors[1].split("").map(c=>`${c}色`).join("、");
  else if (colorMatches.length) fields.colors = [...new Set(colorMatches)].join("、");
  const material = text.match(/(?:材质)[：:\s]*([^,\n]+)/) || text.match(/(不锈钢|陶瓷|帆布|纯棉|硅胶|玻璃|塑料|木质)/);
  if (material) fields.material = material[1].trim();
  const explicitName = text.match(/(?:品名|商品名称)[：:\s]*([^,\n]+)/);
  const knownName = text.match(/(?:不锈钢|陶瓷|玻璃)?保温杯|(?:陶瓷|玻璃)?杯子?|帆布袋|购物袋|收纳盒|玩具|雨伞|水壶/);
  if (explicitName) fields.name = explicitName[1].trim(); else if (knownName) fields.name = knownName[0];
  const sku = text.match(/(?:货号|型号)[：:\s]*([^,\n]+)/);
  if (sku) fields.sku = sku[1].trim();
  const cartonDimensions = text.match(/(?:外箱尺寸|箱规)[：:\s]*([^,\n]+)/);
  if (cartonDimensions) fields.cartonDimensions = cartonDimensions[1].trim();
  const cbm = text.match(/(?:单箱体积|每箱体积|CBM)[：:\s]*(\d+(?:\.\d+)?)\s*(?:m³|m3|立方米)/i);
  if (cbm) fields.cartonCbm = Number(cbm[1]);
  const leadTime = text.match(/(?:大货交期|生产交期|交期)[：:\s]*(\d+)\s*天(?:[,\n]|$)/);
  if (leadTime) fields.leadTimeDays = Number(leadTime[1]);
  const tradeTerms = text.match(/(?:报价条款|价格口径)[：:\s]*([^,\n]+)/);
  if (tradeTerms) fields.tradeTerms = tradeTerms[1].trim();
  const supplier = text.match(/(?:商户|商家|供应商|摊位)[：:\s]*([^,\n]+)/);
  if(supplier) fields.supplier=supplier[1].trim();
  const contact = text.match(/(?:联系方式|联系信息|手机|电话|微信)[：:\s]*([^,\n]+)/);
  if(contact) fields.supplierContact=contact[1].trim();
  const notes = text.match(/(?:备注|待问事项)[：:\s]*([^,\n]+)/);
  if(notes) fields.notes=notes[1].trim();
  const sharedRemark=text.match(/(?:对外备注|商品说明)[：:\s]*([^,\n]+)/);if(sharedRemark)fields.exportRemarks=sharedRemark[1].trim();
  return { fields, mode: "rules", warning: "已根据明确文字整理，请核对。照片仅存档；未提到的信息保持空白。" };
}

export const modelEnabled = () => Boolean(process.env.MODEL_API_KEY && process.env.MODEL_NAME);
export const instruction = `你是外贸现场看货的图文填表助手。读取照片标签与用户描述中的明确商品信息，返回 JSON。字段为 name,sku,supplier,supplierContact,notes,exportRemarks,barcode,colors,material,dimensions,weightG,unitPrice,currency,moq,cartons,quantity,cartonQty,cartonDimensions,cartonCbm,leadTimeDays,tradeTerms。name,sku,supplier,supplierContact,notes,exportRemarks,barcode,colors,material,dimensions,currency,cartonDimensions,tradeTerms 是字符串或 null；colors 多色用顿号连接，不能使用数组。weightG,unitPrice,moq,cartons,quantity,cartonQty,cartonCbm,leadTimeDays 是数字或 null。未知字段填 null。只识别名称与可见颜色，材质有明确标签才填；价格、数量、重量、尺寸、体积、交期、币种、条款必须有明确文字依据，禁止根据外观估算商业数值。单件重量不可由整箱重量推算，商品尺寸与外箱尺寸分别记录，起订量不可当作每箱数量或采购数量。商户名称、联系方式和备注只能提取用户文字或标签明确内容，不猜联系人，不代写个人评分或评价。exportRemarks 仅填写明确标注“对外备注”或“商品说明”的文字，普通备注填 notes。不要添加解释或其他字段。`;

/** 标记为估算的值不能成为正式商业字段。兼容旧模型响应，但只填明确值。 */
export function parseExtractionFields(value: unknown): Partial<ProductFields> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new AppError('UPSTREAM_INVALID', '整理结果格式不正确，请手工核对', 502);
  const { estimates, ...data } = value as Record<string, unknown>;
  if (estimates !== undefined && (!Array.isArray(estimates) || estimates.some(key => typeof key !== 'string'))) throw new AppError('UPSTREAM_INVALID', '整理结果格式不正确，请手工核对', 502);
  // Some providers return explicit colors as a string list despite the text contract.
  // Normalize only that representation; never coerce prices/quantities or arbitrary objects.
  if (Array.isArray(data.colors) && data.colors.length <= 20 && data.colors.every(color => typeof color === 'string' && color.trim().length > 0 && color.length <= 200)) {
    data.colors = [...new Set(data.colors.map(color => (color as string).trim()))].join('、');
  }
  const parsed = extractionSchema.safeParse(data);
  if (!parsed.success) throw new AppError('UPSTREAM_INVALID', '整理结果格式不正确，请手工核对', 502);
  const uncertain = new Set(Array.isArray(estimates) ? estimates : []);
  return Object.fromEntries(Object.entries(parsed.data).filter(([key, v]) => v !== null && !uncertain.has(key))) as Partial<ProductFields>;
}

export async function extractWithModel(description: string, images: string[], fetcher: typeof fetch = secureFetch): Promise<Extraction> {
  const base = (process.env.MODEL_BASE_URL || "https://api.openai.com/v1").replace(/\/$/, "");
  const url = new URL(`${base}/chat/completions`);
  validateServiceURL(url);
  const response = await fetcher(url, {
    method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${process.env.MODEL_API_KEY}` },
    body: JSON.stringify({ model: process.env.MODEL_NAME, max_tokens: 1500, temperature: 0, response_format: { type: "json_object" }, messages: [
      { role: "system", content: instruction },
      { role: "user", content: [ { type: "text", text: description || "仅提取照片标签中明确的信息" }, ...images.map(url=>({type:"image_url",image_url:{url}})) ] },
    ] }), signal: AbortSignal.timeout(30000),
  });
  if (!response.ok) throw new AppError("UPSTREAM_FAILED", `智能整理服务暂不可用（${response.status}），原始记录已保留，可稍后重试或手动填写。`, 502);
  let value: unknown;
  try {
    const result = await response.json();
    value = JSON.parse(result.choices?.[0]?.message?.content || "null");
  } catch { throw new AppError("UPSTREAM_INVALID", "智能整理结果格式不正确，请重试或手动填写。", 502); }
  return { fields: parseExtractionFields(value), mode: 'model', warning: '已整理明确图文信息；未知和估算值保持空白，请核对后保存。', estimates: [] };
}
