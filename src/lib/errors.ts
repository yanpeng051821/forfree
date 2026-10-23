export class AppError extends Error {
  constructor(public code: string, message: string, public status = 400) { super(message); }
}
export function notFound(): never { throw new AppError("NOT_FOUND", "记录不存在或无权访问", 404); }
export function conflict(message = "记录已更新，请重新读取后再修改"): never { throw new AppError("CONFLICT", message, 409); }
