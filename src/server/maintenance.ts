import { closeDB, collectGarbage } from "../lib/db";
try { console.log(JSON.stringify(collectGarbage())); } finally { closeDB(); }
