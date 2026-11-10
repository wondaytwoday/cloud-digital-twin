export class RequestGate{
  private active=0;
  private queue:{resolve:()=>void;reject:(e:unknown)=>void;signal?:AbortSignal;abort:()=>void}[]=[];
  constructor(private readonly limit:number){if(!Number.isInteger(limit)||limit<1)throw new Error('Invalid request limit');}
  async run<T>(work:()=>Promise<T>,signal?:AbortSignal):Promise<T>{
    signal?.throwIfAborted();
    if(this.active<this.limit)this.active++;
    else await new Promise<void>((resolve,reject)=>{
      const item={resolve,reject,signal,abort:()=>{this.queue=this.queue.filter(x=>x!==item);reject(signal?.reason);}};
      this.queue.push(item);signal?.addEventListener('abort',item.abort,{once:true});
    });
    try{signal?.throwIfAborted();return await work();}
    finally{
      const next=this.queue.shift();
      if(next){next.signal?.removeEventListener('abort',next.abort);next.resolve();}
      else this.active--;
    }
  }
}
