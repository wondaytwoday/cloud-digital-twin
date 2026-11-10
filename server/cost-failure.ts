import type {CostCoverage} from '../shared/schema.js';

// Persist only a bounded reason, never raw SDK messages or request details.
export function costFailureReason(error:any):CostCoverage['reason']{
  const status=Number(error?.$metadata?.httpStatusCode??error?.response?.status??error?.status);
  const code=String(error?.code??error?.cause?.code??error?.name??'');
  if(status===401||status===403||/AccessDenied|Unauthorized|UnrecognizedClient|ExpiredToken/i.test(code))return 'denied';
  if(status===429||/Throttl|TooManyRequests|RequestLimitExceeded|LimitExceeded/i.test(code))return 'throttled';
  if(/Timeout|ETIMEDOUT|AbortError/i.test(code))return 'timeout';
  if(/ECONN|ENOTFOUND|EAI_AGAIN|EHOST|ENET|Networking|CERT_|SELF_SIGNED|UNABLE_TO_VERIFY/i.test(code)||error instanceof TypeError&&/fetch|network/i.test(error.message))return 'network';
  return 'unknown';
}
