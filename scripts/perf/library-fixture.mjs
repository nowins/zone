export function createLibraryFixture(count){
 const tracks=Array.from({length:count},(_,i)=>({id:`track-${i}`,path:`C:/ZONE-PERF-GENERATED/${i}.wav`,file_name:`${i%12+1} song ${i}.wav`,extension:'wav',title:`歌曲 ${i} Café 音乐`,artist:`艺术家 ${Math.floor(i/120)}`,album:`专辑 ${Math.floor(i/12)}`,album_artist:`艺术家 ${Math.floor(i/120)}`,track_number:i%12+1,disc_number:1,duration_seconds:180+i%120,genres:[`流派 ${i%12}`],added_at:1700000000000+i}));
 let seed=1729;for(let i=tracks.length-1;i>0;i--){seed=(Math.imul(seed,1664525)+1013904223)>>>0;const j=seed%(i+1);[tracks[i],tracks[j]]=[tracks[j],tracks[i]];}
 const playlists=Array.from({length:100},(_,i)=>({id:`list-${i}`,kind:'manual',name:`列表 ${i}`,description:'生成基准',trackIds:Array.from({length:Math.min(500,Math.ceil(count/100))},(_,j)=>`track-${(i*97+j*13)%count}`)}));
 return {tracks,playlists,favoriteTrackIds:new Set(tracks.filter((_,i)=>i%10===0).map(t=>t.id)),activity:{}};
}
