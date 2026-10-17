import assert from 'node:assert/strict';
import {build} from 'esbuild';
import {writeFile,mkdir} from 'node:fs/promises';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {createLibraryFixture} from './library-fixture.mjs';
import {createHash} from 'node:crypto';
import os from 'node:os';
import {performance} from 'node:perf_hooks';
import {execFileSync} from 'node:child_process';
const phase=process.argv[2]??'before';
if(!/^[a-z0-9-]+$/.test(phase)) throw Error('Use a simple observation label.');
await mkdir('.tmp/perf',{recursive:true});
await build({stdin:{contents:`export {buildCollectionIndex} from './src/utils/collectionEntities';export {searchLibrary} from './src/utils/librarySearch';export {sortCollectionTracks} from './src/utils/collectionBrowser';export {resolvePlaylistTracks} from './src/utils/smartPlaylist';`,resolveDir:process.cwd(),loader:'ts'},outfile:'.tmp/perf/model.mjs',bundle:true,format:'esm',platform:'node',logLevel:'silent'});
const {buildCollectionIndex,searchLibrary,sortCollectionTracks,resolvePlaylistTracks}=await import(pathToFileURL(resolve('.tmp/perf/model.mjs')).href+`?${Date.now()}`);
const hash=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
function summarize(samples){const values=samples.map(s=>s.ms).sort((a,b)=>a-b);return{samples,medianMs:values[3],p95Ms:values[6],minMs:values[0],maxMs:values[6]};}
function measure(name,operation,signature){operation();const samples=[];let value;for(let i=0;i<7;i++){globalThis.gc?.();const memory=process.memoryUsage();const cpu=process.cpuUsage();const start=performance.now();value=operation();const ms=performance.now()-start;const used=process.cpuUsage(cpu);samples.push({ms,cpuMs:(used.user+used.system)/1000,heapDeltaBytes:process.memoryUsage().heapUsed-memory.heapUsed});}return{name,...summarize(samples),resultSha256:hash(signature(value))};}
const result={format:'ZoneLibraryModelObservation',version:1,phase,sourceSha:execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim(),dirty:Boolean(execFileSync('git',['status','--porcelain'],{encoding:'utf8'}).trim()),environment:{node:process.version,os:os.release(),cpu:os.cpus()[0].model,logicalProcessors:os.cpus().length,memoryBytes:os.totalmem(),locale:Intl.Collator().resolvedOptions().locale},samplesPerOperation:7,warmupExcluded:1,limitations:['Node process model CPU, not a browser/native UI or scrolling/paint benchmark','Generated references only, no audio or artwork files read','No cold OS-cache or GPU claims; heap deltas are allocation observations, not retained memory'],scales:[]};
for(const count of [1000,10000,50000]){
 const data=createLibraryFixture(count);const fixtureSha256=hash(data.tracks);const measurements=[];
 measurements.push(measure('buildCollectionIndex',()=>buildCollectionIndex(data.tracks),index=>{assert.equal(index.trackById.size,count);return{albums:index.albums.map(a=>[a.key,a.tracks.map(t=>t.id)]),artists:index.artists.map(a=>[a.artist,a.tracks.map(t=>t.id)])};}));
 const index=buildCollectionIndex(data.tracks);
 measurements.push(measure('titleSort',()=>sortCollectionTracks(data.tracks,{field:'title',direction:'ascending'}),tracks=>tracks.map(t=>t.id)));
 for(const query of ['歌曲','not-present-1729'])measurements.push(measure(`search:${query}`,()=>searchLibrary({...data,albums:index.albums,artists:index.artists,query}),value=>({tracks:value.tracks.map(t=>t.id),albums:value.albums.map(a=>a.key),artists:value.artists.map(a=>a.artist),playlists:value.playlists.map(p=>[p.playlist.id,p.tracks.map(t=>t.id)])})));
 measurements.push(measure('manualPlaylistResolve',()=>data.playlists.map(p=>resolvePlaylistTracks(p,data.tracks,{favoriteTrackIds:data.favoriteTrackIds,activity:data.activity})),lists=>lists.map(l=>l.tracks.map(t=>t.id))));
 result.scales.push({count,playlistCount:data.playlists.length,fixtureSha256,measurements});
 await writeFile(`.tmp/perf/model-${phase}.json`,JSON.stringify(result,null,2));
 console.log(JSON.stringify({count,measurements:measurements.map(m=>({name:m.name,medianMs:m.medianMs,p95Ms:m.p95Ms}))}));
}
