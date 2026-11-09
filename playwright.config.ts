import {defineConfig} from '@playwright/test';
// Runs against the production build, so the CSP and code splitting are part of what gets tested.
export default defineConfig({
  testDir:'e2e',testIgnore:'fake-live-server.ts',timeout:45_000,fullyParallel:true,reporter:'list',retries:process.env.CI?1:0,
  use:{baseURL:'http://127.0.0.1:4399',viewport:{width:1600,height:1000},launchOptions:{executablePath:process.env.PLAYWRIGHT_CHROMIUM_PATH||undefined}},
  webServer:[
    {command:'npm run build && NODE_ENV=production DATA_MODE=mock ATLAS_COLLECTOR=0 PORT=4399 npx tsx server/index.ts',url:'http://127.0.0.1:4399/api/health',reuseExistingServer:false,timeout:120_000},
    {command:'sleep 12 && NODE_ENV=production PORT=4398 npx tsx e2e/fake-live-server.ts',url:'http://127.0.0.1:4398/api/health',reuseExistingServer:false,timeout:120_000},
  ],
});
