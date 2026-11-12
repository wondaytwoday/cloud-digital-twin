import {ZodError} from 'zod';
import {SnapshotValidationError} from '../shared/schema.js';
export function snapshotError(error:unknown):{status:number;error:string}{
  const code=(error as NodeJS.ErrnoException)?.code;
  if(code==='EACCES'||code==='EPERM')return{status:500,error:'스냅샷 저장소를 읽을 권한이 없습니다. 서버의 파일 접근 권한을 확인하세요.'};
  if(code==='ENOENT')return{status:503,error:'수집 결과 파일을 찾을 수 없습니다. 수집 상태와 저장 위치를 확인하세요.'};
  if(error instanceof SnapshotValidationError||error instanceof ZodError||error instanceof SyntaxError)return{status:500,error:'스냅샷 형식 또는 참조가 올바르지 않습니다. 수집 결과와 저장 파일의 무결성을 확인하세요.'};
  if(code==='EIO'||code==='ENOSPC')return{status:500,error:'스냅샷 저장 장치에서 오류가 발생했습니다. 디스크 상태와 여유 공간을 확인하세요.'};
  return{status:500,error:'스냅샷을 읽는 중 내부 오류가 발생했습니다. 서버 로그를 확인하세요.'};
}
