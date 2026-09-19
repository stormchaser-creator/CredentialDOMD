import { veraSource } from '../../../supabase/functions/_shared/veraSourceRegistry.mjs';

export default function VeraSourceReceipt({ evidence }) {
  if (!evidence) return null;
  const sources = Array.isArray(evidence.sources) ? evidence.sources.slice(0, 3).filter(s => veraSource(s?.sourceId)) : [];
  const fetched = sources.filter(s => s.status === 'available' && Number.isFinite(Date.parse(s.fetchedAt)));
  return <div style={{ fontSize: 12, marginTop: 8, opacity: 0.8 }}>
    <div>{fetched.length ? 'Official page excerpts retrieved; this is not a compliance determination.' : evidence.attempted ? 'Source check unavailable. Answer uses saved references.' : 'Saved references; no live source check.'}</div>
    {sources.map(s => <div key={s.sourceId}>
      <a href={veraSource(s.sourceId).url} target="_blank" rel="noopener noreferrer">{veraSource(s.sourceId).title}</a>
      {' — '}{fetched.includes(s) ? `retrieved ${new Date(s.fetchedAt).toISOString().replace('T', ' ').slice(0, 16)} UTC${s.delivery === 'cache' ? ' (cached)' : ''}` : 'not retrieved'}
    </div>)}
    {Array.isArray(evidence.citations) && evidence.citations.length > 0 && <details>
      <summary>Source passages</summary>
      {evidence.citations.slice(0, 6).filter(c => veraSource(c?.sourceId) && typeof c.quote === 'string').map((c, i) => <blockquote key={i} style={{ margin: '6px 0', paddingLeft: 8, borderLeft: '2px solid currentColor' }}>
        {c.quote.slice(0, 300)}{' '}<a href={veraSource(c.sourceId).url} target="_blank" rel="noopener noreferrer">Source</a>
      </blockquote>)}
    </details>}
  </div>;
}
