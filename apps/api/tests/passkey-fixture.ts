// A fictional software authenticator, used only for cryptographic tests.
import {generateKeyPairSync,createHash,randomBytes,sign} from 'node:crypto';
import {isoCBOR} from '@simplewebauthn/server/helpers';
export const origin='https://reader.example.test',rp='reader.example.test';
const hash=(b:string|Buffer)=>createHash('sha256').update(b).digest();
export function authenticator() {
  const {privateKey,publicKey}=generateKeyPairSync('ec',{namedCurve:'prime256v1'});
  const key=publicKey.export({format:'jwk'}),id=randomBytes(32),credentialId=id.toString('base64url');
  const cose=isoCBOR.encode(new Map<any,any>([[1,2],[3,-7],[-1,1],[-2,new Uint8Array(Buffer.from(key.x!,'base64url'))],[-3,new Uint8Array(Buffer.from(key.y!,'base64url'))]]));
  const data=(challenge:string,type:string,otherOrigin=origin)=>Buffer.from(JSON.stringify({type,challenge,origin:otherOrigin,crossOrigin:false}));
  return {
    id:credentialId,
    register(challenge:string,verified=true) {
      const count=Buffer.alloc(4),len=Buffer.alloc(2);len.writeUInt16BE(id.length);
      const authData=Buffer.concat([hash(rp),Buffer.from([verified?0x45:0x41]),count,Buffer.alloc(16),len,id,cose]);
      const att=isoCBOR.encode(new Map<any,any>([['fmt','none'],['attStmt',new Map()],['authData',new Uint8Array(authData)]]));
      return {id:credentialId,rawId:credentialId,type:'public-key',clientExtensionResults:{},response:{clientDataJSON:data(challenge,'webauthn.create').toString('base64url'),attestationObject:Buffer.from(att).toString('base64url'),transports:['internal']}};
    },
    login(challenge:string,userHandle:string,options:{counter?:number;verified?:boolean;origin?:string;tamper?:boolean;rp?:string}={}) {
      const count=Buffer.alloc(4);count.writeUInt32BE(options.counter??0);
      const authData=Buffer.concat([hash(options.rp??rp),Buffer.from([options.verified===false?0x01:0x05]),count]);
      const client=data(challenge,'webauthn.get',options.origin),signature=sign('sha256',Buffer.concat([authData,hash(client)]),privateKey);
      if(options.tamper)signature[signature.length-1]^=1;
      return {id:credentialId,rawId:credentialId,type:'public-key',clientExtensionResults:{},response:{clientDataJSON:client.toString('base64url'),authenticatorData:authData.toString('base64url'),signature:signature.toString('base64url'),userHandle}};
    },
  };
}
