// Reads the production catalog, one read-only query per section.
import { CATALOG_QUERIES, CONFIG_ROWS_QUERY } from './catalog-sql.mjs';
import { prodJson, PROD_PROJECT_REF } from './management-api.mjs';
import { localJson } from './local-db.mjs';

/** Every catalog section from production (Management API, read-only). */
export async function fetchProdCatalog({ log = () => {} } = {}) {
  // "source" is printed into the generated DDL, which must never name the project ref.
  const catalog = { source: 'production', project_ref: PROD_PROJECT_REF, extracted_at: new Date().toISOString() };
  for (const [name, sql] of Object.entries(CATALOG_QUERIES)) {
    log(`  reading ${name}`);
    catalog[name] = await prodJson(sql);
  }
  return catalog;
}

/** The same sections from the local stack. */
export function fetchLocalCatalog() {
  const catalog = { source: 'local', extracted_at: new Date().toISOString() };
  for (const [name, sql] of Object.entries(CATALOG_QUERIES)) catalog[name] = localJson(sql);
  return catalog;
}

export const fetchProdConfigRows = () => prodJson(CONFIG_ROWS_QUERY);
export const fetchLocalConfigRows = () => localJson(CONFIG_ROWS_QUERY);
