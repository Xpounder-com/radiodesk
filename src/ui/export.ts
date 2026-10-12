/** The application download contains code and styles, never the live station DOM. */
export function portableHtml(document:Document):string {
  const clone=document.documentElement.cloneNode(true) as HTMLElement;
  const app=clone.querySelector('#app');if(app)app.innerHTML='';
  clone.querySelectorAll('.dialog-backdrop,.toast').forEach(element=>element.remove());
  return '<!doctype html>\n'+clone.outerHTML;
}
