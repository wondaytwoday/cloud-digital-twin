const labels:Record<string,string>={
  running:'실행 중',succeeded:'프로비저닝 성공',available:'사용 가능',enabled:'활성화',
  runnable:'실행 가능',active:'활성',provisioned:'프로비저닝 완료',up:'가동 중',ready:'준비됨',
  established:'연결됨',attached:'연결됨',stopped:'중지',stopping:'중지 중',deallocated:'할당 해제',
  deallocating:'할당 해제 중',terminated:'종료',suspended:'일시 중단',paused:'일시 정지',
  degraded:'성능 저하',failed:'실패',failure:'실패',error:'오류',down:'중단',unhealthy:'상태 이상',
  inactive:'비활성',unavailable:'사용 불가',impaired:'장애',pending:'대기 중',unknown:'상태 미확인',
  creating:'생성 중',updating:'갱신 중',deleting:'삭제 중',
};
export function statusLabel(status:string){
  const value=status.trim();
  return labels[value.toLowerCase()]??(value||'상태 미확인');
}
