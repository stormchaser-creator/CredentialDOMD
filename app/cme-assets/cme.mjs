// Local navigation only. No provider calls, telemetry, account access or persistence.
export function normalize(value) {
  return String(value).normalize('NFKC').toLowerCase().replace(/[^a-z0-9\s]/g,' ').trim();
}
const stopWords = new Set(['i','a','an','the','my','is','it','do','how','what','where','can','to','for','of','and','in','with','me','does','need','are','find','was','am','be','been','on','or','will','have','has','you','we','they','this','that','when','why','should','must']);
export function findGuides(entries, query, limit = 5) {
  const normalized=normalize(query);
  const exactState=entries.find(entry=>entry.abbreviation===normalized);
  if(exactState)return [exactState];
  if(/\b(password|hacked|stolen|login|log in|sign in|ticket|support)\b/.test(normalized))return [{title:'Get account or product support',summary:'Find help with sign-in and support tickets. Do not share passwords, API keys or patient records.',href:'/help/#get-help'}];
  const tokens=normalized==='do'?['aoa','osteopathic']:[...new Set(normalized.split(/\s+/).filter(t=>t&&!stopWords.has(t)))];
  if (!tokens.length) return [];
  return entries.map((entry,index) => {
    if(tokens.some(t=>t==='free'||t==='affordable')&&entry.kind==='resource'&&!normalize(entry.tags).split(/\s+/).includes('free'))return {entry,index,score:0};
    const title=normalize(entry.title), text=normalize(`${entry.title} ${entry.summary} ${entry.tags||''}`);
    const words=new Set(text.split(/\s+/));
    let score=tokens.reduce((sum,token)=>sum+(words.has(token)?(title.split(/\s+/).includes(token)?4:1):0),0);
    if(entry.abbreviation && (tokens.includes(entry.abbreviation)||normalized.includes(entry.stateName)))score+=20;
    return {entry,index,score};
  }).filter(row=>row.score>0).sort((a,b)=>b.score-a.score||a.index-b.index).slice(0,limit).map(row=>row.entry);
}

export function matchesState(name, abbreviation, query, exactAbbreviation) {
  const normalized=normalize(query);
  return !normalized||(exactAbbreviation?abbreviation===normalized:normalize(name).includes(normalized));
}

if (typeof document !== 'undefined') {
  const entries=[...document.querySelectorAll('[data-guide-entry]')].map(el=>({title:el.dataset.guideTitle,summary:el.dataset.guideSummary,tags:el.dataset.guideTags||'',href:el.dataset.guideHref||`#${el.id}`,abbreviation:el.dataset.abbreviation,stateName:el.dataset.stateName,kind:el.dataset.guideKind}));
  const form=document.getElementById('vera-form'), input=document.getElementById('vera-query');
  const results=document.getElementById('vera-results'), status=document.getElementById('vera-status');
  form.hidden=false;
  form.addEventListener('submit',event=>{
    event.preventDefault();
    const query=input.value.trim();
    results.replaceChildren();
    if (!query) {status.textContent='Enter a topic, state or question to find a guide.'; input.focus(); return;}
    const matches=findGuides(entries,query);
    status.textContent=matches.length?`${matches.length} suggested ${matches.length===1?'guide':'guides'}. Open a result to read the answer and its sources.`:'No matching guide yet. Try a topic such as “transcript” or “DEA”, browse the questions below, or open Get product support.';
    for (const match of matches) {
      const li=document.createElement('li'), a=document.createElement('a'), p=document.createElement('p');
      a.href=match.href; a.textContent=match.title; p.textContent=match.summary;
      li.append(a,p); results.append(li);
    }
  });
  input.addEventListener('input',()=>{results.replaceChildren();status.textContent='';});
  const stateQuery=document.getElementById('state-query'), stateCards=[...document.querySelectorAll('[data-state]')];
  const stateStatus=document.getElementById('state-status');
  document.getElementById('state-filter').hidden=false;
  function filterStates() {
    const query=normalize(stateQuery.value); let count=0;
    const exactAbbreviation=stateCards.some(card=>card.dataset.abbreviation===query);
    for (const card of stateCards) {
      card.hidden=!matchesState(card.dataset.state,card.dataset.abbreviation,query,exactAbbreviation);
      if(!card.hidden) count++;
    }
    stateStatus.textContent=`${count} of ${stateCards.length} state and DC guides shown`;
    document.getElementById('state-empty').hidden=count!==0;
  }
  stateQuery.addEventListener('input',filterStates);filterStates();
  function revealHash() {
    let id; try {id=decodeURIComponent(location.hash.slice(1));} catch {return;}
    if (!id) return;
    const target=document.getElementById(id);if(!target)return;
    if(target.matches('[data-state]')&&target.hidden) {stateQuery.value='';filterStates();}
    if(target.matches('details'))target.open=true;
    // A source may be nested in a collapsed register.
    for(let parent=target.parentElement;parent;parent=parent.parentElement)if(parent.tagName==='DETAILS')parent.open=true;
    target.scrollIntoView({block:'start'});
  }
  document.addEventListener('click',event=>{
    const link=event.target.closest('a[href^="#"]');
    if(link&&link.hash===location.hash)revealHash();
  });
  addEventListener('hashchange',revealHash);revealHash();
}
