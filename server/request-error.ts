export const requestErrorCode=(e:any)=>String(e?.cause?.code??e?.code??e?.name??'Error');
export const connectionTimeout=(e:unknown)=>/UND_ERR_CONNECT_TIMEOUT|ETIMEDOUT|ECONNRESET|EAI_AGAIN|ENOTFOUND|TimeoutError/.test(requestErrorCode(e));
export const proxyConfigured=()=>!!(process.env.HTTPS_PROXY||process.env.HTTP_PROXY||process.env.https_proxy||process.env.http_proxy);
export function requestAdvice(provider:string,error:any,permission?:string){
  const code=requestErrorCode(error).slice(0,64),status=Number(error?.response?.status??error?.status??error?.$metadata?.httpStatusCode);
  if(status===401||status===403||/AccessDenied|Unauthorized|AuthorizationFailed/.test(code))return `${provider}: 조회 권한 거부. ${permission??'읽기 권한과 로그인 상태'}를 확인하세요.`;
  if(/AbortError|ABORT_ERR|ERR_CANCELED/.test(code))return `${provider}: 요청이 중단됐습니다. 수집 취소·제한 시간과 네트워크 상태를 확인하세요.`;
  if(connectionTimeout(error))return proxyConfigured()?`${provider}: 프록시 연결 대기 또는 네트워크 지연으로 요청 시간이 초과됐습니다. 동시 요청 수를 줄이거나 단독 수집으로 다시 확인하세요.`:`${provider}: 네트워크 연결 시간 초과 (${code}). 연결·DNS를 확인하고 프록시가 필요한 환경이면 HTTPS_PROXY 설정을 확인하세요.`;
  if(/CERT|SELF_SIGNED|UNABLE_TO_VERIFY/.test(code))return `${provider}: TLS 인증서를 신뢰하지 못했습니다. NODE_EXTRA_CA_CERTS의 신뢰 인증서를 확인하세요.`;
  return `${provider}: 요청을 완료하지 못했습니다. 수집 상태와 네트워크·API 응답을 확인하세요.`;
}
