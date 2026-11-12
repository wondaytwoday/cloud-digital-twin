// Only executable entry points load local configuration. Importing helpers in
// tests must never load credentials or change the process-wide proxy.
import {loadEnvFiles,configureProxy} from './env.js';
loadEnvFiles();
configureProxy();
