// Offline size catalog. Live deployments can replace this with Resource SKUs / machineTypes.get lookups.
type Sku={vcpu:number;memoryGiB:number;gpu?:string};
export const azureSkus:Record<string,Sku>={Standard_B2s:{vcpu:2,memoryGiB:4},Standard_D2s_v5:{vcpu:2,memoryGiB:8},Standard_D4s_v5:{vcpu:4,memoryGiB:16},Standard_D8s_v5:{vcpu:8,memoryGiB:32},Standard_E4s_v5:{vcpu:4,memoryGiB:32},Standard_NC4as_T4_v3:{vcpu:4,memoryGiB:28,gpu:'1 × NVIDIA T4'}};
export const gcpMachines:Record<string,Sku>={'e2-medium':{vcpu:2,memoryGiB:4},'e2-standard-4':{vcpu:4,memoryGiB:16},'n1-standard-4':{vcpu:4,memoryGiB:15},'n2-standard-8':{vcpu:8,memoryGiB:32}};
export const skuSpecs=(sku:Sku|undefined):Record<string,string>=>sku?{'vCPU':String(sku.vcpu),'메모리':`${sku.memoryGiB} GiB`,'GPU':sku.gpu??'없음'}:{'vCPU':'SKU 추가 조회 필요','메모리':'SKU 추가 조회 필요'};
