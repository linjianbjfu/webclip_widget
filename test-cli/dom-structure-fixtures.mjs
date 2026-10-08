/** Runtime-created trees whose serialization can be changed by the HTML parser. */
export const structureKinds = ['table-tr','table-td','table-col','nested-a','p-div','nested-form','nested-button','table-div','nested-li','nested-heading','select-span'];
export function buildStructure(kind) {
   const root=document.querySelector('#region');const el=(name,text)=>{const n=document.createElement(name);if(text)n.textContent=text;return n;};
   const wrap=(outer,inner)=>{outer.append(inner);root.append(outer)};
   switch(kind){
    case 'table-tr':{const table=el('table'),tr=el('tr');tr.append(el('td','新闻'));wrap(table,tr);break;}
    case 'table-td':wrap(el('table'),el('td','新闻'));break;
    case 'table-col':{const table=el('table');const col=el('col');col.setAttribute('span','2');table.append(col);const row=el('tr');row.append(el('td','新闻'));table.append(row);root.append(table);break;}
    case 'nested-a':{const outer=el('a');outer.href='/story';const h=el('h2','标题'),box=el('div');const author=el('a','作者');author.href='/author';box.append(author);outer.append(h,box);root.append(outer);break;}
    case 'p-div':wrap(el('p','开头'),el('div','正文'));break;
    case 'nested-form':{const outer=el('form');outer.id='outer';const inner=el('form');inner.id='inner';inner.append(el('label','姓名'));wrap(outer,inner);break;}
    case 'nested-button':wrap(el('button','外层'),el('button','内层'));break;
    case 'table-div':{const table=el('table');table.append(el('div','说明'));const tr=el('tr');tr.append(el('td','新闻'));table.append(tr);root.append(table);break;}
    case 'nested-li':{const ul=el('ul'),a=el('li','第一条');a.append(el('li','第二条'));ul.append(a);root.append(ul);break;}
    case 'nested-heading':wrap(el('h2','标题'),el('h3','副标题'));break;
    case 'select-span':{const select=el('select');select.append(el('span','说明'),el('option','选项'));root.append(select);break;}
   }
}
