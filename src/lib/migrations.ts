import type { DatabaseSync } from "node:sqlite";

export function migrate(connection: DatabaseSync) {
  const version = Number((connection.prepare("PRAGMA user_version").get() as { user_version: number }).user_version);
  if (version > 5) throw new Error("数据库版本高于当前程序，拒绝降级启动");
  if (version === 5) return;
  if (version === 4) { migrateMerchants(connection); return; }
  if (version === 3) {migrateTrash(connection);migrateMerchants(connection);return;}
  if (version === 2) { migrateProfiles(connection);migrateTrash(connection);migrateMerchants(connection); return; }
  if (version === 1) { migrateGateway(connection); migrateProfiles(connection);migrateTrash(connection);migrateMerchants(connection); return; }
  connection.exec("BEGIN IMMEDIATE");
  try {
    connection.exec(`
      CREATE TABLE IF NOT EXISTS projects (id TEXT PRIMARY KEY, name TEXT NOT NULL, market TEXT NOT NULL, date TEXT NOT NULL, demo INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS products (id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id), fields TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS users (id TEXT PRIMARY KEY, wechat_id TEXT UNIQUE NOT NULL, created_at TEXT NOT NULL);
      INSERT OR IGNORE INTO users VALUES ('__legacy__', '__legacy__', datetime('now'));
    `);
    const columns = (table: string) => (connection.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map(x => x.name);
    if (!columns("projects").includes("owner_id")) connection.exec("ALTER TABLE projects ADD COLUMN owner_id TEXT NOT NULL DEFAULT '__legacy__'");
    if (!columns("products").includes("version")) connection.exec("ALTER TABLE products ADD COLUMN version INTEGER NOT NULL DEFAULT 1");
    connection.exec(`
      CREATE TABLE IF NOT EXISTS media (id TEXT PRIMARY KEY, owner_id TEXT NOT NULL REFERENCES users(id), product_id TEXT REFERENCES products(id) ON DELETE CASCADE, name TEXT NOT NULL, position INTEGER NOT NULL DEFAULT 0, expires_at INTEGER);
      CREATE TABLE IF NOT EXISTS sessions (token_hash TEXT PRIMARY KEY, owner_id TEXT NOT NULL REFERENCES users(id), expires_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS receipts (owner_id TEXT NOT NULL REFERENCES users(id), request_key TEXT NOT NULL, digest TEXT NOT NULL, result TEXT NOT NULL, created_at INTEGER NOT NULL, PRIMARY KEY(owner_id, request_key));
      CREATE INDEX IF NOT EXISTS projects_owner ON projects(owner_id, created_at);
      CREATE INDEX IF NOT EXISTS products_project ON products(project_id);
      CREATE INDEX IF NOT EXISTS media_product ON media(product_id, position);
      CREATE INDEX IF NOT EXISTS media_expiry ON media(expires_at);
    `);
    if (connection.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='photos'").get()) {
      connection.exec("INSERT OR IGNORE INTO media (id,owner_id,product_id,name,position) SELECT ph.id,p.owner_id,ph.product_id,ph.name,ph.position FROM photos ph JOIN products pr ON pr.id=ph.product_id JOIN projects p ON p.id=pr.project_id");
    }
    connection.exec("PRAGMA user_version=1; COMMIT");
  } catch (error) { connection.exec("ROLLBACK"); throw error; }
  migrateGateway(connection);
  migrateProfiles(connection);
  migrateTrash(connection);
  migrateMerchants(connection);
}
function migrateTrash(connection:DatabaseSync){
  connection.exec('BEGIN IMMEDIATE');
  try{
    const columns=connection.prepare('PRAGMA table_info(products)').all() as {name:string}[];
    if(!columns.some(c=>c.name==='deleted_at'))connection.exec('ALTER TABLE products ADD COLUMN deleted_at TEXT');
    connection.exec('CREATE INDEX IF NOT EXISTS products_trash ON products(deleted_at,created_at); PRAGMA user_version=4; COMMIT');
  }
  catch(error){connection.exec('ROLLBACK');throw error;}
}
function migrateProfiles(connection: DatabaseSync) {
  connection.exec("BEGIN IMMEDIATE");
  try {
    connection.exec("CREATE TABLE IF NOT EXISTS user_profiles (owner_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE, fields TEXT NOT NULL, version INTEGER NOT NULL); PRAGMA user_version=3; COMMIT");
  } catch (error) { connection.exec("ROLLBACK"); throw error; }
}
function migrateGateway(connection: DatabaseSync) {
  connection.exec("BEGIN IMMEDIATE");
  try {
    connection.exec("CREATE TABLE IF NOT EXISTS gateway_sessions (token_hash TEXT PRIMARY KEY REFERENCES sessions(token_hash) ON DELETE CASCADE, encrypted TEXT NOT NULL); PRAGMA user_version=2; COMMIT");
  } catch (error) { connection.exec("ROLLBACK"); throw error; }
}

function migrateMerchants(connection: DatabaseSync) {
  connection.exec('BEGIN IMMEDIATE');
  try {
    const columns=connection.prepare('PRAGMA table_info(projects)').all() as {name:string}[];
    if(!columns.some(c=>c.name==='supplier'))connection.exec('ALTER TABLE projects ADD COLUMN supplier TEXT');
    if(!columns.some(c=>c.name==='supplier_contact'))connection.exec('ALTER TABLE projects ADD COLUMN supplier_contact TEXT');
    connection.exec('PRAGMA user_version=5; COMMIT');
  } catch(error){connection.exec('ROLLBACK');throw error;}
}
