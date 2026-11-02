import {defineConfig} from '@playwright/test';
// Runs against the production build, so the CSP and code splitting are part of what gets tested.
export default defineConfig({
  testDir:'e2e',timeout:45_000,fullyParallel:true,reporter:'list',retries:process.env.CI?1:0,
  use:{baseURL:'http://127.0.0.1:4399',viewport:{width:1600,height:1000},launchOptions:{executablePath:process.env.PLAYWRIGHT_CHROMIUM_PATH||undefined}},
  webServer:{command:'npm run build && NODE_ENV=production PORT=4399 npx tsx server/index.ts',url:'http://127.0.0.1:4399/api/health',reuseExistingServer:false,timeout:120_000},
});
