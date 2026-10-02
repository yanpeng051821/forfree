# 货记 · 市场看货助手

帮助外贸人员把市场现场的商品照片和文字描述整理成商品记录，最终导出带图片的 Excel。

**当前是开发基础交接版本，不是完整可试用 App。** API、数据模型、商品表单组件与核心测试已实现；首页/任务工作台、页面样式和完整浏览器流程尚待接续。当前访问 `/` 会得到 404。

## 开发流程与文档

1. [PRD 与验收标准](docs/PRD.md)
2. [参考资料与调研限制](docs/RESEARCH.md)
3. [页面与交互](docs/INTERACTION.md)
4. [本地 Agent 交接](docs/HANDOFF.md)

## 本地启动

需要 Node.js 24 或更新版本（使用内置 `node:sqlite`）。已有 checkout 直接使用，无需创建 Git worktree。

```bash
npm ci
npm run dev
```

默认端口 3000。目前可访问 `/api/config` 或使用 API；首页尚未实现。
若云环境不能写入默认 npm 缓存，可使用 `NPM_CONFIG_CACHE=/tmp/forfree-npm-cache npm ci`。

## 检查

```bash
npm run test
npm run typecheck
npm run build
npm run test:api
```

`test:api` 在构建后启动独立生产服务（默认端口 3197），使用临时数据库和图片目录，测试完成后清理。可通过 `TEST_PORT` 改端口。

## 数据与模型

- 默认数据在 `.data/market.sqlite` 与 `.data/photos/`，均已被 Git 忽略。`APP_DATA_DIR` 可改变存储位置。
- 没有模型凭据也能使用基础文字整理；它只匹配明确文字，不能识别照片或理解任意复杂口语。
- 可选图文模型：复制 `.env.example` 为 `.env.local`，设置 `MODEL_API_KEY`、`MODEL_NAME` 和兼容 Chat Completions 的 `MODEL_BASE_URL`。密钥仅由后端读取，不能使用 `NEXT_PUBLIC_*` 或提交到 Git。
- 真实外部模型接口尚未验证；现有测试通过模拟响应验证结构校验和错误处理。
- 照片会转为最大 1600px 的 JPEG，去除原始元数据。不要将本项目视为原片备份工具。
- 模拟示例仅通过 `POST /api/demo` 主动创建，使用模拟商户和示意插画。
- 当前没有登录和团队权限，只适合本地或受控环境；不要直接公开部署。

## API

| 路径 | 方法 | 作用 |
| --- | --- | --- |
| `/api/projects` | GET / POST | 列出、创建看货任务 |
| `/api/products?projectId=…` | GET | 列出某任务商品 |
| `/api/products` | POST | multipart 新建/修改商品；字段 JSON 使用 `fields`，图片使用 `photos` |
| `/api/products/:id` | GET / DELETE | 获取、删除商品 |
| `/api/photos/:id` | GET | 读取已保存的商品照片 |
| `/api/extract` | POST | multipart 文字/图文整理 |
| `/api/export?projectId=…` | GET | 导出任务 XLSX（包含首图） |
| `/api/demo` | POST | 幂等载入模拟任务 |
| `/api/config` | GET | 返回是否启用图文模型，不返回凭据 |
