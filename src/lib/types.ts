export type Project = { id: string; name: string; market: string; date: string; demo: boolean; createdAt: string };
export type Photo = { id: string; url: string; name: string };
export type ProductFields = {
  name: string;
  supplier: string;
  colors: string;
  material: string;
  dimensions: string;
  weightG: number | null;
  unitPrice: number | null;
  currency: "CNY" | "USD" | "EUR";
  moq: number | null;
  cartonQty: number | null;
  description: string;
  notes: string;
  confirmed: boolean;
};
export type Product = ProductFields & { id: string; projectId: string; photos: Photo[]; createdAt: string; updatedAt: string };
export type Extraction = { fields: Partial<ProductFields>; mode: "rules" | "model"; warning: string };
export const emptyFields: ProductFields = {
  name: "", supplier: "", colors: "", material: "", dimensions: "", weightG: null,
  unitPrice: null, currency: "CNY", moq: null, cartonQty: null, description: "", notes: "", confirmed: false,
};
