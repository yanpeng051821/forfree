export type ProjectSummary = { total: number; confirmed: number; pending: number; missingPrice: number; suppliers: number; photos: number };
export type Project = { supplier?: string; supplierContact?: string; id: string; name: string; market: string; date: string; demo: boolean; createdAt: string; summary?: ProjectSummary };
export type Photo = { id: string; url: string; name: string };
export type ProductFields = {
  name: string;
  sku: string;
  supplier: string;
  supplierContact: string;
  colors: string;
  material: string;
  dimensions: string;
  weightG: number | null;
  unitPrice: number | null;
  currency: "CNY" | "USD" | "EUR";
  moq: number | null;
  cartonQty: number | null;
  cartons: number | null;
  quantity: number | null;
  barcode: string;
  exportRemarks: string;
  custom: Record<string, string>;
  cartonDimensions: string;
  cartonCbm: number | null;
  leadTimeDays: number | null;
  tradeTerms: string;
  description: string;
  notes: string;
  confirmed: boolean;
  favorite: boolean;
  rating: number | null;
  evaluation: string;
};
export type Product = ProductFields & { id: string; projectId: string; version: number; photos: Photo[]; createdAt: string; updatedAt: string; deletedAt?: string | null; organizeState?: 'queued' | 'done' | 'failed'; organizeJobId?: string; organizeError?: string; taskName?: string; taskMarket?: string; taskDate?: string; demo?: boolean };
export type Extraction = { fields: Partial<ProductFields>; mode: "rules" | "model"; warning: string; estimates?: string[] };
export const emptyFields: ProductFields = {
  name: "", sku: "", supplier: "", supplierContact: "", colors: "", material: "", dimensions: "", weightG: null,
  unitPrice: null, currency: "CNY", moq: null, cartonQty: null, cartons: null, quantity: null, barcode: '', exportRemarks: '', custom: {}, cartonDimensions: "", cartonCbm: null, leadTimeDays: null, tradeTerms: "", description: "", notes: "", confirmed: false, favorite: false, rating: null, evaluation: '',
};
export type UserProfileFields = { avatar?: string; name: string; company: string; role: "buyer" | "merchant" | "both"; phone: string; wechat: string; defaultCurrency: "CNY" | "USD" | "EUR" };
export type UserProfile = UserProfileFields & { version: number };
export const emptyProfile: UserProfileFields = { name: "", company: "", role: "buyer", phone: "", wechat: "", defaultCurrency: "CNY" };
