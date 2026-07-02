export interface Env {
  DB: D1Database;
  STORAGE: R2Bucket;
  ASSETS: Fetcher;
  ACCESS_TEAM_DOMAIN: string;
  ACCESS_APP_AUD: string;
  ENVIRONMENT: string;
  DEV_OPERATOR_EMAIL?: string;
}
