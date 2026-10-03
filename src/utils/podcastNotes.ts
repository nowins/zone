export type NoteNode = {type:"text";text:string}|{type:"element";tag:string;href?:string;children:NoteNode[]};
const allowed=new Set(["p","div","h2","h3","h4","h5","h6","br","strong","b","em","i","ul","ol","li","blockquote","pre","code","span"]);
export function decodeNoteEntities(text:string) {
  const entities:Record<string,string>={amp:"&",lt:"<",gt:">",quot:'"',apos:"'",nbsp:" "};
  return text.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos|nbsp);/gi,(original,name:string)=>{
    if(name[0]!=="#")return entities[name.toLowerCase()] ?? original;
    const code=Number.parseInt(name.slice(name[1].toLowerCase()==="x"?2:1),name[1].toLowerCase()==="x"?16:10);
    return code>0&&code<=0x10ffff&&!(code>=0xd800&&code<=0xdfff)?String.fromCodePoint(code):original;
  });
}
export function safePodcastLink(value:string,base?:string):string|null {
  if(value.length>8192)return null;
  try{const url=new URL(value,base);if(!["http:","https:"].includes(url.protocol)||url.username||url.password||!url.hostname)return null;
    if(url.port&&!['80','443'].includes(url.port))return null;
    const host=url.hostname.toLowerCase().replace(/\.$/,"");if(host==="localhost"||host.endsWith(".localhost")||host.endsWith(".local")||host.startsWith("[")||/^(?:127\.|0\.|10\.|192\.168\.|169\.254\.|172\.(?:1[6-9]|2\d|3[01])\.)/.test(host))return null;
    return url.href;
  }catch{return null;}
}
export function parsePodcastNotes(source:string,base?:string):NoteNode[] {
  const root:NoteNode[]=[];const stack:{tag:string;children:NoteNode[]}[]=[{tag:"root",children:root}];let count=0;let links=0;
  const cleaned=source.slice(0,200_000).replace(/<(script|style|iframe|object|template|svg|math)\b[^>]*>[\s\S]*?<\/\1\s*>/gi,"").replace(/<!--[\s\S]*?-->/g,"");
  for(const match of cleaned.matchAll(/<\/?([a-z][\w-]*)\b[^>]*>|([^<]+)|</gi)) {
    if(++count>5000)break;
    if(!match[1]){
      const children=stack[stack.length-1].children;const text=decodeNoteEntities(match[2]??"<");let offset=0;
      if(!stack.some(node=>node.tag==="a"))for(const link of text.matchAll(/https?:\/\/[^\s<>"']+/gi)) {
        if(links>=200)break;
        let label=link[0].replace(/[.,;!?，。；！？]+$/,"");
        if(label.endsWith(")")&&(label.match(/\)/g)?.length??0)>(label.match(/\(/g)?.length??0))label=label.slice(0,-1);
        const href=safePodcastLink(label,base);if(!href)continue;links++;
        children.push({type:"text",text:text.slice(offset,link.index!)});children.push({type:"element",tag:"span",href,children:[{type:"text",text:label}]});offset=link.index!+label.length;
      }
      children.push({type:"text",text:text.slice(offset)});continue;
    }
    const tag=match[1].toLowerCase();if(!allowed.has(tag)&&tag!=="a")continue;
    if(match[0].startsWith("</")){let index=stack.length-1;while(index>0&&stack[index].tag!==tag)index--;if(index>0)stack.length=index;continue;}
    const href=tag==="a"?match[0].match(/\shref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i):null;
    const url=href?safePodcastLink(decodeNoteEntities(href[1]??href[2]??href[3]),base):null;
    const node:NoteNode={type:"element",tag:tag==="a"?"span":tag,children:[],...(url?{href:url}:{})};stack[stack.length-1].children.push(node);
    if(tag!=="br"&&!match[0].endsWith("/>")&&stack.length<32)stack.push({tag,children:node.children});
  }return root;
}
export function podcastTimecodeSeconds(value:string):number|null {
  const parts=value.split(':').map(Number);if(parts.length<2||parts.length>3||parts.some(n=>!Number.isInteger(n)||n<0))return null;
  if(parts[parts.length-1]>=60||(parts.length===3&&parts[1]>=60))return null;
  const seconds=parts.reduce((sum,n)=>sum*60+n,0);return seconds<=604800?seconds:null;
}
