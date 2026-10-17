// Shared validation and tool declarations. This protocol can only read saved data.
// Deployment addresses belong in the owner's private configuration, never tool input.
export function readerOrigin(value) {
  let url;try{url=new URL(value);}catch{throw Error('credentials_invalid');}
  if(typeof value!=='string'||url.protocol!=='https:'||url.origin!==value||url.port||url.username||url.password||
    !/^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z][a-z0-9-]*[a-z0-9]$/.test(url.hostname)||
    /\.(?:localhost|local|internal)$/.test(url.hostname))throw Error('credentials_invalid');
  return value;
}
export const PREFIX='/mcp-read/';
const page={days:{type:'integer',minimum:1,maximum:7,default:7,description:'いいねしてからの日数。最大7日。'},
  limit:{type:'integer',minimum:1,maximum:20,default:10},cursor:{type:'string',maxLength:200}};
const annotations={readOnlyHint:true,destructiveHint:false,idempotentHint:true,openWorldHint:false};
export const TOOLS=[
  {name:'recent_likes',title:'最近気になった情報',description:'本人が最近Xでいいねして保存した情報を新しい順に読む。既定7日・10件。本文の短い抜粋と著者・元投稿・外部リンク。Xを追加取得せず既読にもしない。',inputSchema:{type:'object',properties:page,additionalProperties:false},annotations},
  {name:'search_likes',title:'いいねストックを探す',description:'保存済みの本文・著者・リンク見出しをキーワードで検索。複数語はAND。最近気になった技術を現在のPJで試す候補探しに使う。PJのソースコードや秘密をqueryへ入れない。',inputSchema:{type:'object',properties:{query:{type:'string',minLength:1,maxLength:160},...page},required:['query'],additionalProperties:false},annotations},
  {name:'get_liked_post',title:'保存した投稿を読む',description:'検索や最近の一覧で見つけた投稿IDを読む。本文・著者・リンク・いいね日時。長文は8000文字ずつ。期限切れでもXを再取得せず、メモや既読を変更しない。',inputSchema:{type:'object',properties:{postId:{type:'string',pattern:'^[0-9]{1,19}$'},textOffset:{type:'integer',minimum:0,maximum:100000,default:0}},required:['postId'],additionalProperties:false},annotations},
  {name:'likes_status',title:'ストックと更新状態',description:'保存件数、直近通知と自動更新の確認時刻、本文の保存期限を確認する。X APIを呼ばない。',inputSchema:{type:'object',properties:{},additionalProperties:false},annotations},
];
export const ACTIONS={recent_likes:'recent',search_likes:'search',get_liked_post:'post',likes_status:'status'};
export function normalizeArgs(action,raw={}) {
  if(!raw || typeof raw!=='object' || Array.isArray(raw))throw Error('invalid_arguments');
  const tool=TOOLS.find(t=>ACTIONS[t.name]===action);if(!tool)throw Error('invalid_arguments');
  if(Object.keys(raw).some(k=>!Object.hasOwn(tool.inputSchema.properties,k)))throw Error('invalid_arguments');
  const integer=(value,fallback,min,max)=>{const n=value===undefined?fallback:value;if(!Number.isInteger(n)||n<min||n>max)throw Error('invalid_arguments');return n;};
  if(action==='status')return {};
  if(action==='post'){
    if(typeof raw.postId!=='string'||!/^[0-9]{1,19}$/.test(raw.postId))throw Error('invalid_arguments');
    return {postId:raw.postId,textOffset:integer(raw.textOffset,0,0,100000)};
  }
  const result={days:integer(raw.days,7,1,7),limit:integer(raw.limit,10,1,20)};
  if(raw.cursor!==undefined){if(typeof raw.cursor!=='string'||raw.cursor.length>200||!/^[A-Za-z0-9_-]+$/.test(raw.cursor))throw Error('invalid_arguments');result.cursor=raw.cursor;}
  if(action==='search'){
    if(typeof raw.query!=='string'||raw.query.length>160||/[\u0000-\u001f\u007f]/.test(raw.query)||!raw.query.trim())throw Error('invalid_arguments');
    result.query=raw.query.normalize('NFKC').trim();
    if(result.query.length>160||result.query.split(/\s+/u).length>6)throw Error('invalid_arguments');
  }
  return result;
}
