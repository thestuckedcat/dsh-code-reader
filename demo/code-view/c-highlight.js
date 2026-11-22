(function(root){
  'use strict';
  // Presentation-only C lexer; colours do not assert semantic resolution.
  const types=new Set('void char short int long float double signed unsigned _Bool _Complex _Imaginary bool wchar_t size_t ptrdiff_t intptr_t uintptr_t'.split(' '));
  const controls=new Set('if else switch case default for while do break continue return goto'.split(' '));
  const keywords=new Set('auto const enum extern inline register restrict sizeof static struct typedef union volatile _Alignas _Alignof _Atomic _Generic _Noreturn _Static_assert _Thread_local'.split(' '));
  function highlightC(source){
    const lines=[[]];let i=0,previous='',header=false;
    const identifier=/[A-Za-z_]\w*/y;
    const number=/(?:0[xX](?:[\da-fA-F]+(?:\.[\da-fA-F]*)?|\.[\da-fA-F]+)(?:[pP][+-]?\d+)?|0[bB][01]+|(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?)[uUlLfF]*/y;
    const emit=(text,kind='plain')=>{text.split('\n').forEach((part,n)=>{if(n)lines.push([]);if(part)lines.at(-1).push({text:part,kind});});};
    while(i<source.length){
      const start=i,c=source[i];let kind='plain';
      if(source.startsWith('/*',i)){
        const end=source.indexOf('*/',i+2);i=end<0?source.length:end+2;kind='comment';
      }else if(source.startsWith('//',i)){
        i+=2;while(i<source.length&&source[i]!=='\n'){if(source[i]==='\\'&&i+1<source.length)i+=2;else i++;}kind='comment';
      }else if(c==='"'||c==="'"||(/^[LuU]$/.test(c)&&(source[i+1]==='"'||source[i+1]==="'"))||source.startsWith('u8"',i)){
        if(source.startsWith('u8"',i))i+=2;else if(c!=='"'&&c!=="'")i++;
        const quote=source[i++];while(i<source.length){if(source[i]==='\\'&&i+1<source.length){i+=2;continue;}if(source[i]==='\n')break;if(source[i++]===quote)break;}kind='string';header=false;
      }else if(header&&c==='<'){
        i++;while(i<source.length&&source[i]!=='\n'&&source[i]!=='>')i++;if(source[i]==='>')i++;kind='string';header=false;
      }else if(c==='#'&&source.slice(source.lastIndexOf('\n',i-1)+1,i).trim()===''){
        const match=/^#[ \t]*[A-Za-z_]\w*/.exec(source.slice(i));i+=match?match[0].length:1;kind='preprocessor';header=/^#[ \t]*include\b/.test(source.slice(start,i));previous='';
      }else if(/[A-Za-z_]/.test(c)){
        identifier.lastIndex=i;const word=identifier.exec(source)[0];i+=word.length;
        kind=controls.has(word)?'control':types.has(word)||/_t$/.test(word)||['struct','union','enum'].includes(previous)?'type':keywords.has(word)?'keyword':/^[A-Z_][A-Z_0-9]*$/.test(word)?'constant':/^\s*\(/.test(source.slice(i))?'function':'identifier';previous=word;
      }else if(/\d/.test(c)||(c==='.'&&/\d/.test(source[i+1]||''))){
        number.lastIndex=i;const match=number.exec(source);i+=match?match[0].length:1;kind='number';previous='';
      }else{
        i++;if(c==='\n'){header=false;previous='';}else if(!/\s/.test(c)){kind='operator';previous='';}
      }
      emit(source.slice(start,i),kind);
    }
    return lines;
  }
  const api={highlightC};if(typeof module!=='undefined')module.exports=api;else root.CHighlight=api;
})(typeof window!=='undefined'?window:globalThis);
