import type {IamAssignment,Link,Resource,Snapshot} from './schema.js';
// How each relation kind reads to an operator. None of them says traffic flows; the flow analyser is the only place that decides that.
export const LINK_LABEL:Record<Link['kind'],string>={attachment:'연결(attached_to)',policy:'정책 적용',peering:'피어링',route:'라우팅',simulation:'시연 트래픽',contains:'포함',owns:'소유(ownerReferences)',forwards_to:'전달',selects:'선택(selector)',resolves_to:'이름 해석',private_link:'Private Link',runs_on:'실행 위치',mounts:'마운트',binds_to:'바인딩',uses_identity:'실행 신원',role_binding:'역할 바인딩',permission_evidence:'권한 근거',observed_flow:'관측 통신'};
export const BASIS_LABEL:Record<NonNullable<Link['basis']>,string>={configured:'구성 수집',inferred:'Atlas 추론',observed:'관측',declared:'수동 등록'};
export const basisOf=(l:Link)=>l.basis?BASIS_LABEL[l.basis]:'구성 수집 (근거 구분 이전 데이터)';
// Who a workload runs as, and what role assignments name that identity. This is evidence of configuration, not an effective-permission verdict:
// conditions, deny assignments, permission boundaries, organisation policies and resource policies are not evaluated and are listed as such.
export type IdentityEvidence={identity:Resource;via:string;assignments:IamAssignment[];onTarget:IamAssignment[];unevaluated:string[]};
const UNEVALUATED:Record<string,string[]>={
  azure:['조건부 역할 할당(ABAC 조건)','거부 할당(deny assignment)','관리 그룹·상위 범위 상속 경로의 세부 평가','스토리지 계정 키·SAS를 통한 접근','리소스의 서비스 방화벽'],
  aws:['인라인·고객 관리형 정책 본문','권한 경계','SCP·RCP','리소스 기반 정책(버킷 정책 등)','세션 정책·조건 키'],
  gcp:['IAM 조건','거부 정책(IAM deny)','조직 정책','VPC 서비스 제어','리소스 수준 IAM의 상속'],
  onprem:[],
};
export function identityEvidence(s:Snapshot,workload:Resource,target?:Resource):IdentityEvidence[]{
  const byId=new Map(s.resources.map(r=>[r.id,r])),out:IdentityEvidence[]=[];
  // A pod runs as its service account, which may in turn be federated to a cloud identity.
  const direct=s.links.filter(l=>l.source===workload.id&&l.kind==='uses_identity').map(l=>({to:byId.get(l.target),via:l.label}));
  const chained=direct.flatMap(d=>d.to?.kind==='serviceaccount'?s.links.filter(l=>l.source===d.to!.id&&l.kind==='uses_identity').map(l=>({to:byId.get(l.target),via:`${d.via} → ${l.label}`})):[]);
  for(const {to,via} of [...direct,...chained]){
    if(!to)continue;
    const pid=to.specs['principalId']?.toLowerCase(),name=to.specs['이메일']??to.name;
    const assignments=s.iam.filter(a=>a.provider===to.provider&&((pid&&a.principalId?.toLowerCase()===pid)||a.principal===name||a.principal===to.specs['역할']));
    const onTarget=target?assignments.filter(a=>a.resourceScope?target.nativeId.toLowerCase().startsWith(a.resourceScope):a.scope===target.scope):[];
    out.push({identity:to,via,assignments,onTarget,unevaluated:to.kind==='serviceaccount'?['Kubernetes RBAC은 클러스터 API 권한이며 클라우드 자원 권한과 별개입니다.']:UNEVALUATED[to.provider]??[]});
  }
  return out;
}
