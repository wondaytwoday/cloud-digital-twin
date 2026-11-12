import {z} from 'zod';
import {SnapshotSchema,validateSnapshot,validateSnapshotIntegrity,type Snapshot} from './schema.js';

const revision=z.string().regex(/^[a-f0-9]{64}$/);
const metadata=SnapshotSchema.omit({resources:true,links:true}).strict();
const ReusedView=z.object({transport:z.literal(1),revision,metadata}).strict();
const FullView=z.object({transport:z.literal(1),revision,snapshot:z.unknown()}).strict();
export type ViewTransport={transport:1;revision:string;snapshot:Snapshot}|{transport:1;revision:string;metadata:Omit<Snapshot,'resources'|'links'>};

export class ViewCache{
  private cores=new Map<string,Pick<Snapshot,'mode'|'resources'|'links'>>();
  get revision(){return [...this.cores.keys()].at(-1);}
  clear(){this.cores.clear();}
  decode(input:unknown):Snapshot{
    // Existing servers and saved exports still use a complete version 1 snapshot.
    if(!input||typeof input!=='object'||!('transport' in input))return validateSnapshot(input);
    if('snapshot' in input){
      const body=FullView.parse(input),snapshot=validateSnapshot(body.snapshot);
      if(snapshot.resources.length){
        this.cores.delete(body.revision);
        this.cores.set(body.revision,{mode:snapshot.mode,resources:snapshot.resources,links:snapshot.links});
        if(this.cores.size>3)this.cores.delete(this.cores.keys().next().value!);
      }
      return snapshot;
    }
    const body=ReusedView.parse(input),core=this.cores.get(body.revision);
    if(!core||core.mode!==body.metadata.mode)throw new Error('화면 데이터 버전이 바뀌었습니다. 새로고침하세요.');
    const snapshot=validateSnapshotIntegrity({...body.metadata,resources:core.resources,links:core.links});
    this.cores.delete(body.revision);this.cores.set(body.revision,core);
    return snapshot;
  }
}
