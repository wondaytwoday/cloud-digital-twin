export const scenarios=[
  {id:'single-vm',label:'VM 1대',group:'단순',hint:'AWS VPC 하나에 EC2 한 대'},
  {id:'web-tier',label:'3계층 웹',group:'단순',hint:'Azure VNet 하나에 LB, VM, SQL'},
  {id:'gke-app',label:'컨테이너 앱',group:'단순',hint:'GCP VPC 하나에 GKE와 Cloud SQL'},
  {id:'hybrid-vpn',label:'사내망 + VPN',group:'단순',hint:'사내망과 AWS VPC를 VPN으로 연결'},
  {id:'standard',label:'멀티클라우드 표준',group:'표준',hint:'3사, 허브-스포크, 전용선'},
  {id:'enterprise',label:'글로벌 엔터프라이즈',group:'복잡',hint:'3사 2개 리전, 계정·구독 약 30개, 이중화 회선'},
] as const;
export type ScenarioId=typeof scenarios[number]['id'];
export const isScenario=(v:unknown):v is ScenarioId=>scenarios.some(s=>s.id===v);
