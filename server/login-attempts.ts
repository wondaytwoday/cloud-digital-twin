export class LoginAttempts{
  private entries=new Map<string,{count:number;until:number}>();
  constructor(private readonly capacity=10_000,private readonly windowMs=60_000,private readonly limit=10){}
  allow(key:string,now=Date.now()){
    // Insertion order is expiry order: blocked attempts never extend a window.
    for(const [id,entry] of this.entries){
      if(entry.until>now)break;
      this.entries.delete(id);
    }
    const entry=this.entries.get(key);
    if(entry){entry.count++;return entry.count<=this.limit;}
    // Do not evict an active ban to admit a new address.
    if(this.entries.size>=this.capacity)return false;
    this.entries.set(key,{count:1,until:now+this.windowMs});
    return true;
  }
}
