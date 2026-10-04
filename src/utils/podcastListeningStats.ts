export type ListeningSample = {episodeId:string|null;clockMs:number;position:number;rate:number;playing:boolean;seeking:boolean};
export function createPodcastListeningMeter() {
  let previous:ListeningSample|null=null;
  const seconds=new Map<string,number>();
  return {
    sample(next:ListeningSample) {
      const last=previous;previous=next;
      if(!last?.episodeId||last.episodeId!==next.episodeId||!last.playing||!next.playing||last.seeking||next.seeking||last.rate!==next.rate)return;
      const elapsed=(next.clockMs-last.clockMs)/1000,advanced=next.position-last.position;
      if(!Number.isFinite(elapsed)||!Number.isFinite(advanced)||!Number.isFinite(next.rate)||next.rate<=0||elapsed<=0||elapsed>3||advanced<=0||advanced>elapsed*next.rate+0.35)return;
      const heard=Math.min(elapsed,advanced/next.rate);
      seconds.set(last.episodeId,(seconds.get(last.episodeId)??0)+heard);
    },
    reset(){previous=null;},
    drain(){const values=Array.from(seconds,([episodeId,seconds])=>({episodeId,seconds}));seconds.clear();return values;},
  };
}
