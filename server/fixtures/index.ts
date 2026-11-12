import type {ScenarioId} from '../../shared/scenarios.js';
import type {Scenario} from './types.js';
import {standard} from './standard.js';
import {singleVm,webTier,gkeApp,hybridVpn} from './simple.js';
import {enterprise} from './enterprise.js';
import {globalScale} from './global-scale.js';
export const fixtures:Record<ScenarioId,Scenario>={'single-vm':singleVm,'web-tier':webTier,'gke-app':gkeApp,'hybrid-vpn':hybridVpn,standard,enterprise,'global-scale':globalScale};
